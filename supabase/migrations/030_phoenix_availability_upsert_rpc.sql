-- 030_phoenix_availability_upsert_rpc.sql
-- Purpose: Replace PostgREST .upsert() (fails 42P10 against the COALESCE partial
--          index 029) with an explicit UPDATE-then-INSERT RPC.
-- Security: SECURITY DEFINER, but mirrors RLS write logic exactly:
--   super_admin -> any org
--   hospital_admin / warehouse_manager -> own org (INSERT+UPDATE)
--   point_operator -> own org, UPDATE only (NO insert)
-- organization_id is DERIVED from distribution_points (never trusted from client).
-- Does NOT touch actor_*/port_name/updated_at -> left to trigger 018.
-- Applied manually via SQL Editor (no db push).

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
  v_dosage     text := COALESCE(p_dosage_form, '');
  v_conc       text := COALESCE(p_concentration, '');
  v_id         uuid;
BEGIN
  -- 0. scientific_name is required for the new path
  IF p_scientific_name IS NULL OR btrim(p_scientific_name) = '' THEN
    RAISE EXCEPTION 'scientific_name_required' USING ERRCODE = '23514';
  END IF;

  -- 1. derive the owning org from the point (trusted source, not the client)
  SELECT organization_id INTO v_point_org
  FROM public.distribution_points
  WHERE id = p_distribution_point_id;

  IF v_point_org IS NULL THEN
    RAISE EXCEPTION 'distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;

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
  INSERT INTO public.item_availability (
    distribution_point_id, organization_id,
    scientific_name, trade_name, dosage_form, concentration,
    quantity, condition, expiry_date, batch_number, notes, supply_type, price
  ) VALUES (
    p_distribution_point_id, v_point_org,
    p_scientific_name, p_trade_name, v_dosage, v_conc,
    p_quantity, p_condition, p_expiry_date, p_batch_number, p_notes, p_supply_type, p_price
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
