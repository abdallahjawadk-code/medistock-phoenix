-- 031_phoenix_availability_upsert_rpc_port_name_fix.sql
-- MANUAL APPLY ONLY — DO NOT use `supabase db push`.
--
-- Purpose: Repository sync for the live hotfix applied to
--          phoenix_upsert_availability after migration 030 was deployed.
--
-- Background:
--   Migration 030 introduced the UPDATE-then-INSERT RPC, but its INSERT did not
--   set port_name. The new editor flow never collects a local_item_id, so the
--   table's identity guard:
--
--     item_availability_identity_chk
--       CHECK (local_item_id IS NOT NULL OR port_name IS NOT NULL)   -- (migration 019)
--
--   rejected every new INSERT with a 23514 violation. The live database
--   function was manually patched in the SQL Editor to derive a non-null
--   port_name from distribution_points and include it in the INSERT. Save then
--   succeeded. This migration records that exact fix as repository history.
--
-- 030 is left untouched as historical; this is the corrective successor.
--
-- What changes vs. 030:
--   * Derive v_port_name from public.distribution_points (trusted source).
--   * INSERT now lists port_name explicitly so the identity check is satisfied.
--   Everything else (signature, security, authorization, UPDATE-first logic,
--   grants) is preserved exactly.
--
-- Security: SECURITY DEFINER, but mirrors RLS write logic exactly:
--   super_admin    -> any org
--   hospital_admin -> own org (INSERT+UPDATE)
--   warehouse_manager -> own org (INSERT+UPDATE)
--   point_operator -> own org, UPDATE only (NO insert)
-- organization_id is DERIVED from distribution_points (never trusted from client).
-- Does NOT touch actor_*/updated_at -> left to trigger 018.

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

  -- 2. authorize: mirror RLS write conditions exactly
  IF v_role = 'super_admin' THEN
    NULL; -- allowed on any org
  ELSIF v_role IN ('hospital_admin', 'warehouse_manager', 'point_operator') THEN
    IF v_point_org <> v_my_org THEN
      RAISE EXCEPTION 'forbidden_cross_org' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'forbidden_role' USING ERRCODE = '42501';
  END IF;

  -- 3. try UPDATE first (matches partial index 029 via COALESCE)
  UPDATE public.item_availability AS ia
     SET quantity      = p_quantity,
         condition     = p_condition,
         expiry_date   = p_expiry_date,
         batch_number  = p_batch_number,
         notes         = p_notes,
         supply_type   = p_supply_type,
         price         = p_price,
         trade_name    = p_trade_name
   WHERE ia.distribution_point_id = p_distribution_point_id
     AND ia.scientific_name       = p_scientific_name
     AND COALESCE(ia.concentration, '') = v_conc
     AND COALESCE(ia.dosage_form,  '') = v_dosage
  RETURNING ia.id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN v_id;  -- updated existing row (allowed for all 4 roles)
  END IF;

  -- 4. no existing row -> this would be an INSERT.
  --    point_operator has UPDATE-only under RLS, so block INSERT here.
  IF v_role = 'point_operator' THEN
    RAISE EXCEPTION 'point_operator_cannot_insert' USING ERRCODE = '42501';
  END IF;

  -- 5. INSERT (super_admin / hospital_admin / warehouse_manager)
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

-- Ask PostgREST to reload its schema cache so the corrected RPC is visible.
NOTIFY pgrst, 'reload schema';
