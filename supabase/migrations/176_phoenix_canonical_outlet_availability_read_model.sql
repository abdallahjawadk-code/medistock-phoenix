-- ============================================================================
-- STAGE-G-G1 — CANONICAL OUTLET AVAILABILITY READ MODEL (176)
--
-- Physical quantity/condition come ONLY from canonical outlet_stock.
-- item_availability is OPTIONAL compatibility metadata/visibility: a missing
-- cache row must never hide real canonical stock and this read path never writes
-- or manufactures a catalogue row. A nullable catalogue_item_availability_id is
-- returned separately from row_key so a stock identity can never be mistaken for
-- an item_availability UUID by visibility actions.
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
     OR NOT has_function_privilege('anon','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION '176 preflight failed: public QR anonymous contract is not intact';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.phoenix_outlet_availability_read_model(p_distribution_point_id uuid)
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
    'ok', true, 'scope', 'distribution_point', 'distribution_point_id', NULL,
    'source', 'canonical_outlet_stock', 'rows', '[]'::jsonb
  );
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000'; END IF;
  SELECT p.organization_id,p.role INTO v_org,v_role FROM public.profiles p WHERE p.id=v_actor AND p.status='active';
  IF NOT FOUND OR p_distribution_point_id IS NULL THEN RETURN v_empty; END IF;
  SELECT d.organization_id INTO v_point_org FROM public.distribution_points d WHERE d.id=p_distribution_point_id;
  IF NOT FOUND OR NOT (v_role='super_admin' OR (v_org IS NOT NULL AND v_org=v_point_org)) THEN RETURN v_empty; END IF;

  WITH canonical AS (
    SELECT s.organization_id,s.distribution_point_id,s.scientific_name,
      COALESCE(s.concentration,'') AS concentration_key,
      COALESCE(s.dosage_form,'') AS dosage_form_key,
      COALESCE(s.national_code,'') AS national_code_key,
      COALESCE(s.batch_number,'') AS batch_number_key,
      COALESCE(s.expiry_date,DATE '0001-01-01') AS expiry_date_key,
      COALESCE(s.internal_batch_reference,'') AS internal_batch_reference_key,
      MAX(s.trade_name) AS trade_name,MAX(s.unit_price) AS unit_price,MAX(s.updated_at) AS updated_at,
      SUM(s.on_hand_quantity)::integer AS on_hand_quantity,
      SUM(s.available_quantity)::integer AS available_quantity
    FROM public.outlet_stock s
    WHERE s.distribution_point_id=p_distribution_point_id
    GROUP BY s.organization_id,s.distribution_point_id,s.scientific_name,
      COALESCE(s.concentration,''),COALESCE(s.dosage_form,''),COALESCE(s.national_code,''),
      COALESCE(s.batch_number,''),COALESCE(s.expiry_date,DATE '0001-01-01'),COALESCE(s.internal_batch_reference,'')
  ), catalogue AS (
    SELECT ia.*,
      COALESCE(ia.concentration,'') AS concentration_key,
      COALESCE(ia.dosage_form,'') AS dosage_form_key,
      COALESCE(ia.national_code,'') AS national_code_key,
      COALESCE(ia.batch_number,'') AS batch_number_key,
      COALESCE(ia.expiry_date,DATE '0001-01-01') AS expiry_date_key,
      COALESCE(ia.internal_batch_reference,'') AS internal_batch_reference_key
    FROM public.item_availability ia WHERE ia.distribution_point_id=p_distribution_point_id
  ), joined AS (
    SELECT c.organization_id AS canonical_org_id,c.distribution_point_id AS canonical_point_id,
      c.scientific_name AS canonical_scientific_name,c.concentration_key AS canonical_concentration_key,
      c.dosage_form_key AS canonical_dosage_form_key,c.national_code_key AS canonical_national_code_key,
      c.batch_number_key AS canonical_batch_number_key,c.expiry_date_key AS canonical_expiry_date_key,
      c.internal_batch_reference_key AS canonical_internal_ref_key,c.trade_name AS canonical_trade_name,
      c.unit_price AS canonical_unit_price,c.updated_at AS canonical_updated_at,c.on_hand_quantity,c.available_quantity,
      ia.id AS catalogue_id,ia.local_item_id,ia.organization_id AS catalogue_org_id,ia.port_name,
      ia.scientific_name AS catalogue_scientific_name,ia.trade_name AS catalogue_trade_name,
      ia.concentration AS catalogue_concentration,ia.dosage_form AS catalogue_dosage_form,
      ia.national_code AS catalogue_national_code,ia.batch_number AS catalogue_batch_number,
      ia.expiry_date AS catalogue_expiry_date,ia.internal_batch_reference AS catalogue_internal_ref,
      ia.notes,ia.supply_type,ia.price,ia.removed_at,ia.updated_at AS catalogue_updated_at
    FROM canonical c
    FULL OUTER JOIN catalogue ia
      ON ia.scientific_name=c.scientific_name
     AND ia.concentration_key=c.concentration_key
     AND ia.dosage_form_key=c.dosage_form_key
     AND ia.national_code_key=c.national_code_key
     AND ia.batch_number_key=c.batch_number_key
     AND ia.expiry_date_key=c.expiry_date_key
     AND ia.internal_batch_reference_key=c.internal_batch_reference_key
  ), shaped AS (
    SELECT j.catalogue_id AS id,j.catalogue_id AS catalogue_item_availability_id,
      CASE WHEN j.catalogue_id IS NOT NULL THEN 'catalogue:'||j.catalogue_id::text
        ELSE 'stock:'||md5(concat_ws('|',p_distribution_point_id::text,j.canonical_scientific_name,
          j.canonical_concentration_key,j.canonical_dosage_form_key,j.canonical_national_code_key,
          j.canonical_batch_number_key,j.canonical_expiry_date_key::text,j.canonical_internal_ref_key)) END AS row_key,
      j.local_item_id,p_distribution_point_id AS distribution_point_id,
      COALESCE(j.canonical_org_id,j.catalogue_org_id) AS organization_id,
      COALESCE(j.available_quantity,0) AS quantity,
      public.phoenix_derive_outlet_availability_condition(COALESCE(j.available_quantity,0),COALESCE(j.catalogue_expiry_date,NULLIF(j.canonical_expiry_date_key,DATE '0001-01-01'))) AS condition,
      COALESCE(j.catalogue_batch_number,NULLIF(j.canonical_batch_number_key,'')) AS batch_number,
      COALESCE(j.catalogue_national_code,NULLIF(j.canonical_national_code_key,'')) AS national_code,
      COALESCE(j.catalogue_expiry_date,NULLIF(j.canonical_expiry_date_key,DATE '0001-01-01')) AS expiry_date,
      j.notes,COALESCE(j.catalogue_updated_at,j.canonical_updated_at) AS updated_at,j.port_name,j.supply_type,j.removed_at,
      COALESCE(j.canonical_scientific_name,j.catalogue_scientific_name) AS scientific_name,
      COALESCE(j.catalogue_trade_name,j.canonical_trade_name) AS trade_name,
      COALESCE(j.catalogue_dosage_form,NULLIF(j.canonical_dosage_form_key,'')) AS dosage_form,
      COALESCE(j.catalogue_concentration,NULLIF(j.canonical_concentration_key,'')) AS concentration,
      COALESCE(j.price,j.canonical_unit_price) AS price,
      COALESCE(j.catalogue_internal_ref,NULLIF(j.canonical_internal_ref_key,'')) AS internal_batch_reference,
      COALESCE(j.on_hand_quantity,0) AS canonical_on_hand_quantity,
      COALESCE(j.available_quantity,0) AS canonical_available_quantity,
      CASE WHEN public.phoenix_derive_outlet_availability_condition(COALESCE(j.available_quantity,0),COALESCE(j.catalogue_expiry_date,NULLIF(j.canonical_expiry_date_key,DATE '0001-01-01'))) IN ('expired','missing') THEN 0 ELSE COALESCE(j.available_quantity,0) END AS canonical_usable_quantity,
      CASE WHEN li.id IS NULL THEN NULL ELSE jsonb_build_object('id',li.id,'local_code',li.local_code,
        'central_items',CASE WHEN ci.id IS NULL THEN NULL ELSE jsonb_build_object('id',ci.id,'name',ci.name,'name_ar',ci.name_ar,'unit',ci.unit,'barcode',ci.barcode) END) END AS local_items
    FROM joined j
    LEFT JOIN public.local_items li ON li.id=j.local_item_id
    LEFT JOIN public.central_items ci ON ci.id=li.central_item_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'catalogue_item_availability_id', s.catalogue_item_availability_id,
    'row_key', s.row_key,
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
  ) ORDER BY s.updated_at DESC NULLS LAST,s.row_key),'[]'::jsonb)
  INTO v_rows FROM shaped s;

  RETURN jsonb_build_object('ok',true,'scope','distribution_point','distribution_point_id',p_distribution_point_id,'source','canonical_outlet_stock','rows',v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) TO service_role;

COMMENT ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) IS
  'STAGE-G-G1 / 176: canonical-first authenticated outlet availability CQRS. Physical quantity/condition derive only from outlet_stock. item_availability is optional catalogue/visibility metadata. canonical-only rows remain visible with a NULL catalogue id; row_key is display identity only and must never be passed to visibility writers.';

DO $verify$
BEGIN
  IF NOT has_function_privilege('authenticated','public.phoenix_outlet_availability_read_model(uuid)'::regprocedure,'EXECUTE') OR NOT has_function_privilege('service_role','public.phoenix_outlet_availability_read_model(uuid)'::regprocedure,'EXECUTE') THEN RAISE EXCEPTION '176 verify failed: legitimate execution grants missing'; END IF;
  IF has_function_privilege('anon','public.phoenix_outlet_availability_read_model(uuid)'::regprocedure,'EXECUTE') THEN RAISE EXCEPTION '176 verify failed: anon can execute authenticated read model'; END IF;
  IF NOT has_function_privilege('anon','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE') THEN RAISE EXCEPTION '176 verify failed: public QR anonymous contract changed'; END IF;
END;
$verify$;

COMMIT;
