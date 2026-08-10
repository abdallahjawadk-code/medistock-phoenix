-- ============================================================================
-- STAGE-G-G1 — CANONICAL OUTLET AVAILABILITY READ MODEL (176)
--
-- Physical quantity/condition MUST come from canonical outlet_stock. The legacy
-- item_availability table is retained only as compatibility catalogue metadata
-- (id, visibility marker, notes/display fields). This RPC joins those two roles
-- without ever trusting item_availability.quantity or item_availability.condition.
--
-- Additive only: one new read RPC. No table/RLS/write-path/public-QR change.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.outlet_stock') IS NULL
     OR to_regclass('public.item_availability') IS NULL
     OR to_regclass('public.distribution_points') IS NULL THEN
    RAISE EXCEPTION '176 preflight failed: canonical/read-model tables missing';
  END IF;

  IF to_regprocedure('public.phoenix_derive_outlet_availability_condition(integer,date)') IS NULL THEN
    RAISE EXCEPTION '176 preflight failed: canonical outlet condition helper missing';
  END IF;

  IF to_regprocedure('public.get_public_qr_payload(text)') IS NULL
     OR NOT has_function_privilege('anon', 'public.get_public_qr_payload(text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '176 preflight failed: public QR anonymous contract is not intact';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.phoenix_outlet_availability_read_model(
  p_distribution_point_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_role text;
  v_point_org uuid;
  v_rows jsonb;
  v_empty jsonb := jsonb_build_object(
    'ok', true,
    'scope', 'distribution_point',
    'distribution_point_id', NULL,
    'source', 'canonical_outlet_stock',
    'rows', '[]'::jsonb
  );
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT p.organization_id, p.role
    INTO v_org, v_role
  FROM public.profiles p
  WHERE p.id = v_actor
    AND p.status = 'active';

  IF NOT FOUND OR p_distribution_point_id IS NULL THEN
    RETURN v_empty;
  END IF;

  SELECT d.organization_id
    INTO v_point_org
  FROM public.distribution_points d
  WHERE d.id = p_distribution_point_id;

  -- Forbidden and nonexistent points are deliberately indistinguishable.
  IF NOT FOUND
     OR NOT (v_role = 'super_admin' OR (v_org IS NOT NULL AND v_org = v_point_org)) THEN
    RETURN v_empty;
  END IF;

  -- Every canonical stock identity must have its compatibility catalogue row.
  -- Failing closed is safer than silently omitting real stock from the UI.
  IF EXISTS (
    WITH canonical AS (
      SELECT
        s.scientific_name,
        COALESCE(s.concentration, '') AS concentration_key,
        COALESCE(s.dosage_form, '') AS dosage_form_key,
        COALESCE(s.national_code, '') AS national_code_key,
        COALESCE(s.batch_number, '') AS batch_number_key,
        COALESCE(s.expiry_date, DATE '0001-01-01') AS expiry_date_key,
        COALESCE(s.internal_batch_reference, '') AS internal_batch_reference_key
      FROM public.outlet_stock s
      WHERE s.distribution_point_id = p_distribution_point_id
      GROUP BY
        s.scientific_name,
        COALESCE(s.concentration, ''),
        COALESCE(s.dosage_form, ''),
        COALESCE(s.national_code, ''),
        COALESCE(s.batch_number, ''),
        COALESCE(s.expiry_date, DATE '0001-01-01'),
        COALESCE(s.internal_batch_reference, '')
    )
    SELECT 1
    FROM canonical c
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.item_availability ia
      WHERE ia.distribution_point_id = p_distribution_point_id
        AND ia.scientific_name = c.scientific_name
        AND COALESCE(ia.concentration, '') = c.concentration_key
        AND COALESCE(ia.dosage_form, '') = c.dosage_form_key
        AND COALESCE(ia.national_code, '') = c.national_code_key
        AND COALESCE(ia.batch_number, '') = c.batch_number_key
        AND COALESCE(ia.expiry_date, DATE '0001-01-01') = c.expiry_date_key
        AND COALESCE(ia.internal_batch_reference, '') = c.internal_batch_reference_key
    )
  ) THEN
    RAISE EXCEPTION 'availability_projection_cache_mismatch' USING ERRCODE = '23514';
  END IF;

  WITH canonical AS (
    SELECT
      s.scientific_name,
      COALESCE(s.concentration, '') AS concentration_key,
      COALESCE(s.dosage_form, '') AS dosage_form_key,
      COALESCE(s.national_code, '') AS national_code_key,
      COALESCE(s.batch_number, '') AS batch_number_key,
      COALESCE(s.expiry_date, DATE '0001-01-01') AS expiry_date_key,
      COALESCE(s.internal_batch_reference, '') AS internal_batch_reference_key,
      SUM(s.on_hand_quantity)::integer AS on_hand_quantity,
      SUM(s.available_quantity)::integer AS available_quantity
    FROM public.outlet_stock s
    WHERE s.distribution_point_id = p_distribution_point_id
    GROUP BY
      s.scientific_name,
      COALESCE(s.concentration, ''),
      COALESCE(s.dosage_form, ''),
      COALESCE(s.national_code, ''),
      COALESCE(s.batch_number, ''),
      COALESCE(s.expiry_date, DATE '0001-01-01'),
      COALESCE(s.internal_batch_reference, '')
  ), shaped AS (
    SELECT
      ia.id,
      ia.local_item_id,
      ia.distribution_point_id,
      ia.organization_id,
      COALESCE(c.available_quantity, 0) AS quantity,
      public.phoenix_derive_outlet_availability_condition(
        COALESCE(c.available_quantity, 0), ia.expiry_date
      ) AS condition,
      ia.batch_number,
      ia.national_code,
      ia.expiry_date,
      ia.notes,
      ia.updated_at,
      ia.port_name,
      ia.supply_type,
      ia.removed_at,
      ia.scientific_name,
      ia.trade_name,
      ia.dosage_form,
      ia.concentration,
      ia.price,
      ia.internal_batch_reference,
      COALESCE(c.on_hand_quantity, 0) AS canonical_on_hand_quantity,
      COALESCE(c.available_quantity, 0) AS canonical_available_quantity,
      CASE
        WHEN public.phoenix_derive_outlet_availability_condition(
               COALESCE(c.available_quantity, 0), ia.expiry_date
             ) IN ('expired', 'missing') THEN 0
        ELSE COALESCE(c.available_quantity, 0)
      END AS canonical_usable_quantity,
      CASE WHEN li.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', li.id,
        'local_code', li.local_code,
        'central_items', CASE WHEN ci.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id', ci.id,
          'name', ci.name,
          'name_ar', ci.name_ar,
          'unit', ci.unit,
          'barcode', ci.barcode
        ) END
      ) END AS local_items
    FROM public.item_availability ia
    LEFT JOIN canonical c
      ON ia.scientific_name = c.scientific_name
     AND COALESCE(ia.concentration, '') = c.concentration_key
     AND COALESCE(ia.dosage_form, '') = c.dosage_form_key
     AND COALESCE(ia.national_code, '') = c.national_code_key
     AND COALESCE(ia.batch_number, '') = c.batch_number_key
     AND COALESCE(ia.expiry_date, DATE '0001-01-01') = c.expiry_date_key
     AND COALESCE(ia.internal_batch_reference, '') = c.internal_batch_reference_key
    LEFT JOIN public.local_items li ON li.id = ia.local_item_id
    LEFT JOIN public.central_items ci ON ci.id = li.central_item_id
    WHERE ia.distribution_point_id = p_distribution_point_id
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', s.id,
      'local_item_id', s.local_item_id,
      'distribution_point_id', s.distribution_point_id,
      'organization_id', s.organization_id,
      'quantity', s.quantity,
      'condition', s.condition,
      'batch_number', s.batch_number,
      'national_code', s.national_code,
      'expiry_date', s.expiry_date,
      'notes', s.notes,
      'updated_at', s.updated_at,
      'port_name', s.port_name,
      'supply_type', s.supply_type,
      'removed_at', s.removed_at,
      'scientific_name', s.scientific_name,
      'trade_name', s.trade_name,
      'dosage_form', s.dosage_form,
      'concentration', s.concentration,
      'price', s.price,
      'internal_batch_reference', s.internal_batch_reference,
      'canonical_on_hand_quantity', s.canonical_on_hand_quantity,
      'canonical_available_quantity', s.canonical_available_quantity,
      'canonical_usable_quantity', s.canonical_usable_quantity,
      'local_items', s.local_items
    ) ORDER BY s.updated_at DESC, s.id
  ), '[]'::jsonb)
  INTO v_rows
  FROM shaped s;

  RETURN jsonb_build_object(
    'ok', true,
    'scope', 'distribution_point',
    'distribution_point_id', p_distribution_point_id,
    'source', 'canonical_outlet_stock',
    'rows', v_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) TO service_role;

COMMENT ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) IS
  'STAGE-G-G1 / 176: authenticated CQRS read model for outlet availability. '
  'Physical quantity and condition derive only from outlet_stock; item_availability '
  'contributes catalogue identity/visibility/display metadata only. Fails closed '
  'if canonical stock lacks a matching compatibility-cache identity.';

DO $verify$
BEGIN
  IF NOT has_function_privilege('authenticated',
       'public.phoenix_outlet_availability_read_model(uuid)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.phoenix_outlet_availability_read_model(uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '176 verify failed: legitimate execution grants missing';
  END IF;

  IF has_function_privilege('anon',
       'public.phoenix_outlet_availability_read_model(uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '176 verify failed: anon can execute authenticated read model';
  END IF;

  IF NOT has_function_privilege('anon',
       'public.get_public_qr_payload(text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '176 verify failed: public QR anonymous contract changed';
  END IF;
END;
$verify$;

COMMIT;
