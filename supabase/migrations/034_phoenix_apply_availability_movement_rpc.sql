-- ============================================================================
-- MIGRATION 034 — phoenix_apply_availability_movement RPC
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: 001 (item_availability, profiles), 010 (permission matrix +
-- phoenix_profile_has_permission, phoenix_my_role, phoenix_my_org), 014
-- (actor-snapshot trigger + pattern this migration mirrors for the new
-- ledger table, which has no trigger of its own), 020 (item_availability
-- material-identity columns), 033 (item_availability_movements schema +
-- the 7 quantity-movement permission keys this RPC enforces — REQUIRED,
-- already applied by the owner).
--
-- Task: AVAILABILITY-QUANTITY-MOVEMENT-RPC-A
--
-- Purpose:
--   Creates the SECURITY DEFINER RPC that is the ONLY way to write a row into
--   item_availability_movements (migration 033 grants zero INSERT/UPDATE/
--   DELETE privilege to any client role) and the only way for a movement
--   (set_exact/add/subtract/correction) to change item_availability.quantity
--   with a corresponding auditable ledger entry, atomically, in one
--   transaction (Postgres functions are single-transaction by default).
--
-- What this migration does NOT do:
--   - Does NOT modify migration 033 or any other prior migration.
--   - Does NOT modify phoenix_upsert_availability (migration 032) in any way.
--   - Does NOT add any INSERT/UPDATE/DELETE policy on item_availability or
--     item_availability_movements — item_availability_movements remains
--     writable ONLY through this SECURITY DEFINER function (which bypasses
--     RLS internally, exactly like phoenix_upsert_availability already does
--     for item_availability).
--   - Does NOT touch get_public_qr_payload, qr_tokens, qr_targets, or any
--     other QR-related object.
--   - Does NOT touch EditorScreen or StatusCenter — no frontend UI wiring.
--   - Does NOT weaken any existing RLS policy anywhere.
--
-- Security:
--   - SECURITY DEFINER, SET search_path = public.
--   - REVOKE ALL FROM PUBLIC, anon; GRANT EXECUTE TO authenticated only.
--   - auth.uid() required (raises not_authenticated otherwise).
--   - Target row is SELECTed FOR UPDATE (row lock) before any check, so two
--     concurrent movements on the same item_availability row cannot race.
--   - organization_id / distribution_point_id / scientific_name /
--     concentration / dosage_form / trade_name are read from the LOCKED
--     item_availability row, never from client input — mirrors
--     phoenix_upsert_availability's existing "never trust the client for
--     server-authoritative fields" rule.
--   - super_admin bypasses org scope; every other role must match
--     item_availability.organization_id = phoenix_my_org().
--   - Each movement_type requires its own permission key
--     (availability.quantity.set/add/subtract/correct), checked via
--     phoenix_profile_has_permission(auth.uid(), '<key>') — mirrors the
--     permission-matrix pattern established in migration 032.
--   - quantity_after < 0 raises quantity_cannot_go_negative and rolls back
--     the whole transaction (no item_availability UPDATE, no movements
--     INSERT) — Postgres functions abort the entire transaction on an
--     unhandled exception, so this is atomic by construction.
--
-- Actor snapshot: item_availability_movements has no INSERT/UPDATE trigger
-- of its own (migration 033 intentionally created none, since only this RPC
-- may ever insert into it). This function therefore resolves the actor
-- identity snapshot itself, manually mirroring the exact resolution logic
-- of phoenix_populate_actor_snapshot() (migration 014): profiles.full_name,
-- auth.users.email (LEFT JOIN, since email requires SECURITY DEFINER
-- privilege), profiles.role.
--
-- Also updates item_availability.last_updated_by = auth.uid() as part of
-- the same UPDATE, so item_availability's own existing
-- trg_actor_snapshot/phoenix_set_updated_at triggers (migrations 001/014)
-- correctly re-snapshot the CURRENT actor and updated_at for the row being
-- moved — without this, item_availability's actor snapshot would still
-- reflect whoever last touched it via phoenix_upsert_availability, not the
-- actor who performed this quantity movement.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement(
  p_item_availability_id uuid,
  p_movement_type        text,
  p_amount               integer,
  p_reason               text DEFAULT NULL,
  p_notes                text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor           uuid := auth.uid();
  v_role            text;
  v_my_org          uuid;
  v_is_super        boolean;
  v_row             public.item_availability%ROWTYPE;
  v_quantity_before integer;
  v_quantity_after  integer;
  v_quantity_delta  integer;
  v_movement_id     uuid;
  v_actor_name      text;
  v_actor_email     text;
  v_actor_role      text;
BEGIN
  -- 1. Auth required
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- 2. Basic input validation
  IF p_item_availability_id IS NULL THEN
    RAISE EXCEPTION 'item_availability_id_required' USING ERRCODE = '23514';
  END IF;

  IF p_movement_type IS NULL OR p_movement_type NOT IN ('set_exact', 'add', 'subtract', 'correction') THEN
    RAISE EXCEPTION 'invalid_movement_type' USING ERRCODE = '23514';
  END IF;

  IF p_amount IS NULL THEN
    RAISE EXCEPTION 'amount_required' USING ERRCODE = '23514';
  END IF;

  -- set_exact / correction: amount is the new absolute quantity -> >= 0
  IF p_movement_type IN ('set_exact', 'correction') AND p_amount < 0 THEN
    RAISE EXCEPTION 'amount_must_be_non_negative' USING ERRCODE = '23514';
  END IF;

  -- add / subtract: amount is a magnitude to apply -> > 0 (a zero-amount
  -- add/subtract would not be a real movement and should use set_exact/correction instead)
  IF p_movement_type IN ('add', 'subtract') AND p_amount <= 0 THEN
    RAISE EXCEPTION 'amount_must_be_positive' USING ERRCODE = '23514';
  END IF;

  IF p_movement_type = 'correction' AND (p_reason IS NULL OR btrim(p_reason) = '') THEN
    RAISE EXCEPTION 'correction_reason_required' USING ERRCODE = '23514';
  END IF;

  -- 3. Lock the target row before any authorization/math (prevents concurrent-movement races)
  SELECT * INTO v_row
  FROM public.item_availability
  WHERE id = p_item_availability_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'availability_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- 4. Authorize: org scope (organization_id is read from the LOCKED row,
  --    never trusted from client input) + permission per movement type.
  v_role     := phoenix_my_role();
  v_my_org   := phoenix_my_org();
  v_is_super := (v_role = 'super_admin');

  IF NOT v_is_super AND v_row.organization_id <> v_my_org THEN
    RAISE EXCEPTION 'forbidden_cross_org' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super THEN
    IF p_movement_type = 'set_exact' AND NOT phoenix_profile_has_permission(v_actor, 'availability.quantity.set') THEN
      RAISE EXCEPTION 'forbidden_availability_quantity_set' USING ERRCODE = '42501';
    ELSIF p_movement_type = 'add' AND NOT phoenix_profile_has_permission(v_actor, 'availability.quantity.add') THEN
      RAISE EXCEPTION 'forbidden_availability_quantity_add' USING ERRCODE = '42501';
    ELSIF p_movement_type = 'subtract' AND NOT phoenix_profile_has_permission(v_actor, 'availability.quantity.subtract') THEN
      RAISE EXCEPTION 'forbidden_availability_quantity_subtract' USING ERRCODE = '42501';
    ELSIF p_movement_type = 'correction' AND NOT phoenix_profile_has_permission(v_actor, 'availability.quantity.correct') THEN
      RAISE EXCEPTION 'forbidden_availability_quantity_correct' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 5. Quantity math. item_availability.quantity is `integer not null default 0
  --    check (quantity >= 0)` (migration 001) — never null, so no COALESCE needed.
  v_quantity_before := v_row.quantity;

  CASE p_movement_type
    WHEN 'set_exact' THEN
      v_quantity_after := p_amount;
      v_quantity_delta := p_amount - v_quantity_before;
    WHEN 'add' THEN
      v_quantity_after := v_quantity_before + p_amount;
      v_quantity_delta := p_amount;
    WHEN 'subtract' THEN
      v_quantity_after := v_quantity_before - p_amount;
      v_quantity_delta := -p_amount;
    WHEN 'correction' THEN
      v_quantity_after := p_amount;
      v_quantity_delta := p_amount - v_quantity_before;
  END CASE;

  -- 6. Negative guard — raising here rolls back the whole transaction:
  --    no item_availability UPDATE and no item_availability_movements INSERT.
  IF v_quantity_after < 0 THEN
    RAISE EXCEPTION 'quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;

  -- 7. Resolve actor identity snapshot — item_availability_movements has no
  --    trigger of its own (migration 033), so this mirrors
  --    phoenix_populate_actor_snapshot()'s exact resolution logic (migration 014).
  SELECT p.full_name, u.email, p.role
    INTO v_actor_name, v_actor_email, v_actor_role
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.id = v_actor;

  -- 8. Atomic write: update the locked row (item_availability's own
  --    trg_actor_snapshot + set_updated_at triggers fire automatically and
  --    re-snapshot the current actor because last_updated_by is set here),
  --    then insert the immutable movement record.
  UPDATE public.item_availability
     SET quantity        = v_quantity_after,
         last_updated_by = v_actor
   WHERE id = p_item_availability_id;

  INSERT INTO public.item_availability_movements (
    item_availability_id, organization_id, distribution_point_id,
    scientific_name, concentration, dosage_form, trade_name,
    movement_type, quantity_before, quantity_delta, quantity_after,
    reason, notes, created_by,
    actor_name_snapshot, actor_email_snapshot, actor_role_snapshot
  ) VALUES (
    v_row.id, v_row.organization_id, v_row.distribution_point_id,
    v_row.scientific_name, v_row.concentration, v_row.dosage_form, v_row.trade_name,
    p_movement_type, v_quantity_before, v_quantity_delta, v_quantity_after,
    p_reason, p_notes, v_actor,
    v_actor_name, v_actor_email, v_actor_role
  )
  RETURNING id INTO v_movement_id;

  RETURN jsonb_build_object(
    'ok', true,
    'item_availability_id', v_row.id,
    'movement_id', v_movement_id,
    'movement_type', p_movement_type,
    'quantity_before', v_quantity_before,
    'quantity_delta', v_quantity_delta,
    'quantity_after', v_quantity_after
  );
END;
$$;

-- Restrict execution to authenticated users only (RLS-equivalent gate happens
-- inside the function body — org scope + per-movement-type permission checks).
REVOKE ALL ON FUNCTION public.phoenix_apply_availability_movement(
  uuid, text, integer, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_apply_availability_movement(
  uuid, text, integer, text, text
) TO authenticated;

-- ============================================================================
-- VERIFY
-- ============================================================================

DO $$
DECLARE
  v_fn_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_fn_src
  FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement';

  ASSERT v_fn_src IS NOT NULL,
    'VERIFY FAILED: phoenix_apply_availability_movement function not found';
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%',
    'VERIFY FAILED: phoenix_apply_availability_movement is not SECURITY DEFINER';
  ASSERT v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: phoenix_apply_availability_movement missing SET search_path';
  ASSERT v_fn_src LIKE '%FOR UPDATE%',
    'VERIFY FAILED: phoenix_apply_availability_movement does not lock the row with FOR UPDATE';
  ASSERT v_fn_src LIKE '%phoenix_profile_has_permission%',
    'VERIFY FAILED: phoenix_apply_availability_movement does not check phoenix_profile_has_permission';
  ASSERT v_fn_src LIKE '%availability.quantity.set%'
     AND v_fn_src LIKE '%availability.quantity.add%'
     AND v_fn_src LIKE '%availability.quantity.subtract%'
     AND v_fn_src LIKE '%availability.quantity.correct%',
    'VERIFY FAILED: not all four quantity-movement permission keys are checked';
  ASSERT v_fn_src LIKE '%quantity_cannot_go_negative%',
    'VERIFY FAILED: negative-quantity guard not found';
  ASSERT v_fn_src LIKE '%correction_reason_required%',
    'VERIFY FAILED: correction reason requirement not found';
  ASSERT v_fn_src LIKE '%INSERT INTO public.item_availability_movements%',
    'VERIFY FAILED: does not insert into item_availability_movements';
  ASSERT v_fn_src LIKE '%UPDATE public.item_availability%',
    'VERIFY FAILED: does not update item_availability';

  -- Grants: authenticated only, anon/PUBLIC excluded
  ASSERT EXISTS (
    SELECT 1
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'phoenix_apply_availability_movement'
      AND grantee = 'authenticated'
      AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated does not have EXECUTE on phoenix_apply_availability_movement';

  ASSERT NOT EXISTS (
    SELECT 1
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'phoenix_apply_availability_movement'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon or PUBLIC has EXECUTE on phoenix_apply_availability_movement';

  -- No new INSERT/UPDATE/DELETE policy was added on item_availability_movements
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'item_availability_movements'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
  ), 'VERIFY FAILED: an INSERT/UPDATE/DELETE policy exists on item_availability_movements — none should';

  RAISE NOTICE '034 OK: phoenix_apply_availability_movement created (SECURITY DEFINER, authenticated-only, org+permission gated, atomic row-locked update + immutable movement insert, no new table policies).';
END $$;

-- ============================================================================
-- END OF MIGRATION 034
--
-- Post-apply manual verification (run in Supabase SQL Editor):
--
-- 1. Confirm grants:
--    SELECT grantee, privilege_type FROM information_schema.routine_privileges
--    WHERE routine_schema = 'public' AND routine_name = 'phoenix_apply_availability_movement';
--    -- expect: authenticated | EXECUTE  (no anon, no PUBLIC row)
--
-- 2. Functional smoke test (as an authenticated user with availability.quantity.add):
--    SELECT phoenix_apply_availability_movement(
--      '<existing item_availability.id>', 'add', 5, null, 'smoke test'
--    );
--    -- expect: {"ok": true, "item_availability_id": "...", "movement_id": "...",
--    --          "movement_type": "add", "quantity_before": N, "quantity_delta": 5,
--    --          "quantity_after": N+5}
--
-- 3. Confirm the movement row was recorded:
--    SELECT * FROM item_availability_movements ORDER BY created_at DESC LIMIT 1;
--
-- 4. Confirm negative-guard rollback (subtract more than available):
--    SELECT phoenix_apply_availability_movement('<id>', 'subtract', 999999, null, null);
--    -- expect: ERROR quantity_cannot_go_negative — then re-check that BOTH
--    -- item_availability.quantity is unchanged AND no new movement row was inserted.
--
-- 5. Confirm correction without reason is rejected:
--    SELECT phoenix_apply_availability_movement('<id>', 'correction', 10, null, null);
--    -- expect: ERROR correction_reason_required
--
-- 6. Confirm cross-org denial (as a non-super user targeting another org's item):
--    -- expect: ERROR forbidden_cross_org
--
-- 7. Confirm permission denial (as a role lacking the relevant quantity key,
--    e.g. viewer attempting 'add'):
--    -- expect: ERROR forbidden_availability_quantity_add
--
-- NOTE: This migration creates the RPC only. No UI calls it yet — see
-- AVAILABILITY-QUANTITY-MOVEMENT-MODE-AUDIT-A for the planned UI phase.
-- ============================================================================
