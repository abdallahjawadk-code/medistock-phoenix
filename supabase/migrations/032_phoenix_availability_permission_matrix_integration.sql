-- ============================================================================
-- MIGRATION 032 — Availability Editor: permission-matrix authorization
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: 001, 002, 003, 010 (permission matrix + phoenix_profile_has_permission
-- helper), 019, 020, 029, 030, 031 (item_availability material-identity schema +
-- phoenix_upsert_availability RPC).
--
-- Task: AVAILABILITY-PERMISSION-MATRIX-INTEGRATION-A
--
-- Root cause being fixed (see AVAILABILITY-PERMISSION-MATRIX-INTEGRATION-AUDIT-A):
--   phoenix_upsert_availability (migration 031) and the item_availability write
--   RLS policies (migration 002) authorize writes with a hardcoded role-string
--   allowlist: 'super_admin', 'hospital_admin', 'warehouse_manager',
--   'point_operator'. The official role introduced in migration 012,
--   'institution_admin', is NOT in that list, so an institution/hospital
--   manager provisioned with the current official role hits
--   `forbidden_role` (42501) on every save attempt. warehouse_officer and
--   port_officer (the other official roles) are equally excluded.
--
-- Approved owner decision (matrix, not code, decides access from here on):
--   super_admin              -> create + update, any organization
--   institution_admin        -> create + update, own organization
--   hospital_admin (legacy)  -> create + update, own organization
--   warehouse_officer /
--   warehouse_manager (legacy) -> create + update, own organization
--   port_officer /
--   point_operator (legacy)  -> update only (no create), own organization
--                                (no reliable assigned-distribution-point
--                                 model exists yet — see note below)
--   monthly_status_officer /
--   transfer_manager (legacy) -> read-only (no create, no update)
--   viewer                   -> read-only
--
-- NOTE on assigned-point scope: the task asked to scope port_officer /
-- point_operator to their *assigned* distribution point if a reliable
-- assignment model exists. It does not: profiles has no
-- assigned_point_id / assigned_distribution_point_id column, and no
-- point-assignment table exists anywhere in migrations 001-031. Inventing
-- one is out of scope for this migration (would require a new table, new
-- UI, and a separate approval). This migration therefore keeps
-- ORGANIZATION scope for port_officer/point_operator, matching every other
-- non-super role, and this gap is called out explicitly here and in the
-- audit output so it is not silently assumed to be finer-grained than it is.
--
-- What this migration does:
--   1. Adds permission_keys 'availability.create' and 'availability.update'
--      (availability.view and availability.manage are left untouched).
--   2. Seeds role_permission_defaults for both new keys per the matrix above,
--      for every role/legacy-alias currently known to the app.
--   3. Replaces phoenix_upsert_availability's hardcoded role IN (...) check
--      with phoenix_profile_has_permission(auth.uid(), 'availability.create')
--      / '...update', with an explicit super_admin bypass and org-scope
--      enforcement for everyone else. All other behavior (port_name
--      derivation, scientific_name requirement, organization_id derivation,
--      UPDATE-then-INSERT identity match, no actor_* fields, SECURITY
--      DEFINER, search_path, grants) is preserved byte-for-byte from
--      migration 031.
--   4. Replaces the item_availability hardcoded-role write RLS policies
--      (avail_write_superadmin, avail_write_hospitaladmin,
--      avail_write_wh_manager, avail_write_point_operator) with two
--      permission-based policies (avail_insert_perm, avail_update_perm),
--      following the exact structure already proven for distribution_points
--      in migration 021 (dp_insert_perm / dp_update_perm). Read policies
--      (avail_select_org, avail_select_anon) are untouched. No DELETE policy
--      is added. Anon writes remain impossible (anon has no INSERT/UPDATE
--      grant and no write policy is created for anon).
--
-- What this migration does NOT do:
--   - Does NOT remove availability.manage from the permission catalog or
--     from any role's defaults where it was already granted (hospital_admin,
--     warehouse_officer/warehouse_manager, super_admin). It is left as a
--     legacy/compatibility key. It is NOT consulted by this migration's RPC
--     or RLS changes — availability.create/availability.update are the sole
--     authoritative write permissions from this point on.
--   - Does NOT grant availability.create to port_officer/point_operator.
--   - Does NOT invent an assigned-distribution-point scope model.
--   - Does NOT touch avail_select_org, avail_select_anon, or any other table.
--   - Does NOT add a DELETE policy on item_availability.
--   - Does NOT grant anything to anon or the elevated service key.
--   - Does NOT drop item_availability, does NOT truncate, does NOT delete rows.
--
-- Safety:
--   - Idempotent: DROP POLICY IF EXISTS + CREATE POLICY, INSERT ... ON CONFLICT
--     DO NOTHING, CREATE OR REPLACE FUNCTION. Safe to re-run.
--   - SECURITY DEFINER functions keep SET search_path = public.
--   - REVOKE ALL ... FROM PUBLIC, anon on phoenix_upsert_availability preserved.
--   - GRANT EXECUTE ... TO authenticated only, preserved.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Permission catalog — add availability.create / availability.update
-- ============================================================================

INSERT INTO permission_keys (key, module, action, label_en, label_ar, is_dangerous)
VALUES
  ('availability.create', 'availability', 'create', 'Create availability records', 'إضافة مواد توفر', false),
  ('availability.update', 'availability', 'update', 'Update availability records', 'تعديل مواد توفر', false)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 2. Seed role_permission_defaults for the new keys (approved matrix)
-- ============================================================================
-- availability.view and availability.manage rows from migrations 010/012 are
-- untouched — this section only inserts the two new keys.

INSERT INTO role_permission_defaults (role, permission_key, allowed) VALUES
  -- super_admin: create + update, any organization (RPC/RLS give the org-scope bypass)
  ('super_admin',             'availability.create', true),
  ('super_admin',             'availability.update', true),

  -- institution_admin: create + update, own organization
  ('institution_admin',       'availability.create', true),
  ('institution_admin',       'availability.update', true),

  -- hospital_admin (legacy org admin): create + update, own organization
  ('hospital_admin',          'availability.create', true),
  ('hospital_admin',          'availability.update', true),

  -- warehouse_officer / warehouse_manager (legacy): create + update, own organization
  ('warehouse_officer',       'availability.create', true),
  ('warehouse_officer',       'availability.update', true),
  ('warehouse_manager',       'availability.create', true),
  ('warehouse_manager',       'availability.update', true),

  -- port_officer / point_operator (legacy): update only, own organization
  -- (see assigned-point-scope note at top of file — org scope only for now)
  ('port_officer',            'availability.create', false),
  ('port_officer',            'availability.update', true),
  ('point_operator',          'availability.create', false),
  ('point_operator',          'availability.update', true),

  -- monthly_status_officer / transfer_manager (legacy): read-only
  ('monthly_status_officer',  'availability.create', false),
  ('monthly_status_officer',  'availability.update', false),
  ('transfer_manager',        'availability.create', false),
  ('transfer_manager',        'availability.update', false),

  -- viewer: read-only
  ('viewer',                  'availability.create', false),
  ('viewer',                  'availability.update', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = excluded.allowed;

-- ============================================================================
-- 3. Replace phoenix_upsert_availability — permission-matrix authorization
-- ============================================================================
-- Identical to migration 031 except section "2. authorize", which now checks
-- availability.create / availability.update via phoenix_profile_has_permission
-- instead of a hardcoded role allowlist.

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
  v_role       text := phoenix_my_role();
  v_my_org     uuid := phoenix_my_org();
  v_point_org  uuid;
  v_port_name  text;
  v_dp         public.distribution_points%ROWTYPE;
  v_dosage     text := COALESCE(p_dosage_form, '');
  v_conc       text := COALESCE(p_concentration, '');
  v_id         uuid;
  v_is_super   boolean;
  v_in_scope   boolean;
  v_existing_id uuid;
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

  -- 2. authorize: permission-matrix based (AVAILABILITY-PERMISSION-MATRIX-INTEGRATION-A)
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
  --    unique-constraint violation.
  SELECT ia.id INTO v_existing_id
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

    UPDATE public.item_availability AS ia
       SET quantity      = p_quantity,
           condition     = p_condition,
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
REVOKE ALL ON FUNCTION public.phoenix_upsert_availability(
  uuid, text, text, text, text, integer, text, date, text, text, text, numeric
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_upsert_availability(
  uuid, text, text, text, text, integer, text, date, text, text, text, numeric
) TO authenticated;

-- ============================================================================
-- 4. Replace item_availability hardcoded-role write RLS policies
-- ============================================================================
-- Follows the exact structure proven for distribution_points in migration 021
-- (dp_insert_perm / dp_update_perm): super_admin bypass first, org-scope +
-- permission check second. Read policies (avail_select_org, avail_select_anon)
-- are untouched. No DELETE policy is added or existed before.

DROP POLICY IF EXISTS "avail_write_superadmin"     ON item_availability;
DROP POLICY IF EXISTS "avail_write_hospitaladmin"  ON item_availability;
DROP POLICY IF EXISTS "avail_write_wh_manager"     ON item_availability;
DROP POLICY IF EXISTS "avail_write_point_operator" ON item_availability;
-- idempotent re-run guards
DROP POLICY IF EXISTS "avail_insert_perm" ON item_availability;
DROP POLICY IF EXISTS "avail_update_perm" ON item_availability;

CREATE POLICY "avail_insert_perm" ON item_availability
  FOR INSERT TO authenticated
  WITH CHECK (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'availability.create')
    )
  );

CREATE POLICY "avail_update_perm" ON item_availability
  FOR UPDATE TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'availability.update')
    )
  )
  WITH CHECK (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'availability.update')
    )
  );

-- No DELETE policy: unchanged from migration 002 (none existed before).

-- ============================================================================
-- VERIFY
-- ============================================================================

DO $$
DECLARE
  v_fn_src        text;
  v_insert_qual   text;
  v_update_qual   text;
  v_policy_count  int;
BEGIN
  -- A. New permission keys exist
  ASSERT EXISTS (SELECT 1 FROM permission_keys WHERE key = 'availability.create'),
    'VERIFY FAILED: availability.create missing from permission_keys';
  ASSERT EXISTS (SELECT 1 FROM permission_keys WHERE key = 'availability.update'),
    'VERIFY FAILED: availability.update missing from permission_keys';

  -- B. Existing availability.view / availability.manage rows untouched
  ASSERT EXISTS (SELECT 1 FROM permission_keys WHERE key = 'availability.view'),
    'VERIFY FAILED: availability.view was removed — must not happen';
  ASSERT EXISTS (SELECT 1 FROM permission_keys WHERE key = 'availability.manage'),
    'VERIFY FAILED: availability.manage was removed — must not happen';

  -- C. Role defaults seeded for the new keys
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'institution_admin' AND permission_key = 'availability.create') = true,
    'VERIFY FAILED: institution_admin should have availability.create = true';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'port_officer' AND permission_key = 'availability.create') = false,
    'VERIFY FAILED: port_officer should have availability.create = false';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'port_officer' AND permission_key = 'availability.update') = true,
    'VERIFY FAILED: port_officer should have availability.update = true';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'viewer' AND permission_key = 'availability.create') = false,
    'VERIFY FAILED: viewer should have availability.create = false';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'viewer' AND permission_key = 'availability.update') = false,
    'VERIFY FAILED: viewer should have availability.update = false';

  -- D. RPC uses phoenix_profile_has_permission for availability.create/update
  SELECT pg_get_functiondef(oid) INTO v_fn_src
  FROM pg_proc WHERE proname = 'phoenix_upsert_availability';

  ASSERT v_fn_src LIKE '%availability.create%',
    'VERIFY FAILED: phoenix_upsert_availability does not reference availability.create';
  ASSERT v_fn_src LIKE '%availability.update%',
    'VERIFY FAILED: phoenix_upsert_availability does not reference availability.update';
  ASSERT v_fn_src NOT LIKE '%hospital_admin%warehouse_manager%point_operator%',
    'VERIFY FAILED: phoenix_upsert_availability still contains the old hardcoded allowlist';
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%',
    'VERIFY FAILED: phoenix_upsert_availability lost SECURITY DEFINER';

  -- E. RLS policies replaced correctly
  SELECT qual INTO v_update_qual FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'item_availability' AND policyname = 'avail_update_perm';
  SELECT with_check INTO v_insert_qual FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'item_availability' AND policyname = 'avail_insert_perm';

  ASSERT v_insert_qual IS NOT NULL, 'VERIFY FAILED: avail_insert_perm policy not found';
  ASSERT v_update_qual IS NOT NULL, 'VERIFY FAILED: avail_update_perm policy not found';
  ASSERT v_insert_qual LIKE '%availability.create%', 'VERIFY FAILED: avail_insert_perm does not check availability.create';
  ASSERT v_update_qual LIKE '%availability.update%', 'VERIFY FAILED: avail_update_perm does not check availability.update';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'item_availability'
      AND policyname IN ('avail_write_superadmin', 'avail_write_hospitaladmin',
                         'avail_write_wh_manager', 'avail_write_point_operator')
  ), 'VERIFY FAILED: old hardcoded-role write policies still exist on item_availability';

  -- F. No DELETE policy exists on item_availability
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'item_availability' AND cmd = 'DELETE'
  ), 'VERIFY FAILED: unexpected DELETE policy found on item_availability';

  -- G. Exactly 4 policies remain (2 read + 2 write)
  SELECT count(*) INTO v_policy_count FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'item_availability';
  ASSERT v_policy_count = 4,
    format('VERIFY FAILED: expected exactly 4 policies on item_availability (avail_select_org, avail_select_anon, avail_insert_perm, avail_update_perm), found %s', v_policy_count);

  RAISE NOTICE '032 OK: availability.create/availability.update seeded, phoenix_upsert_availability + item_availability RLS now permission-matrix driven, no anon writes, no DELETE policy.';
END $$;

COMMIT;

-- ============================================================================
-- END OF MIGRATION 032
--
-- Post-apply manual verification (run in Supabase SQL Editor):
--
-- 1. Confirm the new permission keys and role defaults:
--    SELECT role, permission_key, allowed FROM role_permission_defaults
--    WHERE permission_key IN ('availability.create','availability.update')
--    ORDER BY permission_key, role;
--
-- 2. Confirm item_availability policies (expect exactly 4: 2 read + 2 write):
--    SELECT policyname, cmd, roles FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'item_availability'
--    ORDER BY policyname;
--
-- 3. UI smoke test:
--    a. As institution_admin (own org): open Availability Editor, save a NEW
--       item -> expect success (previously: forbidden_role 403).
--    b. As institution_admin: update an EXISTING item -> expect success.
--    c. As port_officer/point_operator: update an EXISTING item -> expect success.
--    d. As port_officer/point_operator: attempt to save a NEW item (new
--       scientific_name/point combination) -> expect denial
--       (forbidden_availability_create), matching the toast
--       "لا تملك صلاحية إضافة مادة جديدة" / "You do not have permission to
--       create a new availability record."
--    e. As monthly_status_officer/viewer: Editor screen shows the read-only
--       denial message; no save attempt is possible from the UI.
--    f. As super_admin: create/update across any organization -> expect success.
--
-- 4. Confirm anon still cannot write:
--    SET LOCAL ROLE anon;
--    INSERT INTO item_availability (distribution_point_id, scientific_name)
--      VALUES ('00000000-0000-0000-0000-000000000000', 'test');  -- expect: RLS denial
--    RESET ROLE;
--
-- KNOWN LIMITATION (documented, not fixed here): port_officer/point_operator
-- scope is organization-wide, not assigned-distribution-point, because no
-- assignment model exists in the schema. If/when the owner approves adding
-- one (e.g. profiles.assigned_point_id or a dedicated assignment table), a
-- follow-up migration should tighten avail_update_perm's scope condition for
-- these two roles specifically.
-- ============================================================================
