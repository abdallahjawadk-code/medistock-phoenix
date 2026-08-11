-- ============================================================================
-- STAGE-G-G2 — CANONICAL PUBLIC QR (177)
--
-- Preserve the long-lived public QR contract while cutting every physical
-- quantity/condition read away from item_availability. outlet_stock is the
-- only outlet inventory truth. item_availability is consulted only as optional
-- catalogue visibility metadata (removed_at), never for quantity/condition.
--
-- No table/RLS/index/write-path changes. Same function signature and return
-- type. Public anonymous execution and the existing scan counter are preserved.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.get_public_qr_payload(text)') IS NULL THEN
    RAISE EXCEPTION '177 preflight failed: public QR function missing';
  END IF;
  IF to_regprocedure('public.phoenix_outlet_availability_read_model(uuid)') IS NULL THEN
    RAISE EXCEPTION '177 preflight failed: G1 canonical read model missing';
  END IF;
  IF to_regprocedure('public.phoenix_derive_outlet_availability_condition(integer,date)') IS NULL THEN
    RAISE EXCEPTION '177 preflight failed: canonical condition helper missing';
  END IF;
  IF to_regclass('public.outlet_stock') IS NULL
     OR to_regclass('public.item_availability') IS NULL
     OR to_regclass('public.qr_tokens') IS NULL
     OR to_regclass('public.qr_targets') IS NULL THEN
    RAISE EXCEPTION '177 preflight failed: required tables missing';
  END IF;
  IF NOT has_function_privilege('anon','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('authenticated','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('service_role','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION '177 preflight failed: existing QR execution contract drifted';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.get_public_qr_payload(p_public_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_token   public.qr_tokens%ROWTYPE;
  v_target  public.qr_targets%ROWTYPE;
  v_org     public.organizations%ROWTYPE;
  v_payload jsonb;
BEGIN
  SELECT * INTO v_token
  FROM public.qr_tokens
  WHERE public_id = p_public_id AND status = 'active'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'error','QR_NOT_FOUND_OR_DISABLED');
  END IF;

  SELECT * INTO v_target FROM public.qr_targets WHERE id = v_token.qr_target_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'error','TARGET_NOT_FOUND');
  END IF;

  SELECT * INTO v_org FROM public.organizations WHERE id = v_target.organization_id;

  -- Preserve the historical public-QR side effect exactly: every successful
  -- active-token resolution records the scan before target-specific rendering.
  UPDATE public.qr_tokens
  SET last_scanned_at = now(), scan_count = scan_count + 1
  WHERE id = v_token.id;

  CASE v_target.target_type
    WHEN 'distribution_point' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.distribution_points
        WHERE id=v_target.target_id AND status='active'
      ) THEN
        RETURN jsonb_build_object('ok',false,'error','DISTRIBUTION_POINT_NOT_ACTIVE');
      END IF;

      SELECT jsonb_build_object(
        'ok',true,
        'target_type','distribution_point',
        'org_name',v_org.name,
        'org_name_ar',v_org.name_ar,
        'point_label',coalesce(v_target.label,dp.name),
        'items',(
          WITH canonical AS (
            SELECT
              s.central_item_id,
              s.scientific_name,
              coalesce(s.concentration,'') AS concentration_key,
              coalesce(s.dosage_form,'') AS dosage_form_key,
              coalesce(s.unit,'') AS unit_key,
              coalesce(s.national_code,'') AS national_code_key,
              coalesce(s.batch_number,'') AS batch_number_key,
              coalesce(s.expiry_date,DATE '0001-01-01') AS expiry_date_key,
              coalesce(s.internal_batch_reference,'') AS internal_ref_key,
              sum(coalesce(s.available_quantity,0))::integer AS available_quantity
            FROM public.outlet_stock s
            WHERE s.distribution_point_id=v_target.target_id
            GROUP BY s.central_item_id,s.scientific_name,
              coalesce(s.concentration,''),coalesce(s.dosage_form,''),coalesce(s.unit,''),
              coalesce(s.national_code,''),coalesce(s.batch_number,''),
              coalesce(s.expiry_date,DATE '0001-01-01'),coalesce(s.internal_batch_reference,'')
          ), visible AS (
            SELECT c.*,ci.name AS central_name,ci.name_ar AS central_name_ar,ci.unit AS central_unit,
              public.phoenix_derive_outlet_availability_condition(
                c.available_quantity,NULLIF(c.expiry_date_key,DATE '0001-01-01')) AS effective_condition
            FROM canonical c
            LEFT JOIN public.central_items ci ON ci.id=c.central_item_id
            WHERE NOT EXISTS (
              SELECT 1
              FROM public.item_availability ia
              LEFT JOIN public.local_items li_hidden ON li_hidden.id=ia.local_item_id
              WHERE ia.distribution_point_id=v_target.target_id
                AND ia.removed_at IS NOT NULL
                AND (
                  (c.central_item_id IS NOT NULL AND li_hidden.central_item_id=c.central_item_id)
                  OR coalesce(ia.scientific_name,'')=coalesce(c.scientific_name,'')
                )
                AND coalesce(ia.concentration,'')=c.concentration_key
                AND coalesce(ia.dosage_form,'')=c.dosage_form_key
                AND coalesce(ia.national_code,'')=c.national_code_key
                AND coalesce(ia.batch_number,'')=c.batch_number_key
                AND coalesce(ia.expiry_date,DATE '0001-01-01')=c.expiry_date_key
                AND coalesce(ia.internal_batch_reference,'')=c.internal_ref_key
            )
          ), shaped AS (
            SELECT
              coalesce(v.central_name,v.central_name_ar,v.scientific_name,'Unnamed material') AS row_name,
              coalesce(v.central_name_ar,v.central_name,v.scientific_name,'مادة غير مسماة') AS row_name_ar,
              coalesce(v.central_unit,NULLIF(v.unit_key,'')) AS row_unit,
              NULLIF(v.concentration_key,'') AS concentration,
              NULLIF(v.dosage_form_key,'') AS dosage_form,
              NULLIF(v.expiry_date_key,DATE '0001-01-01') AS expiry_date,
              v.available_quantity,
              v.effective_condition,
              CASE
                WHEN v.expiry_date_key=DATE '0001-01-01' THEN NULL
                WHEN v.expiry_date_key<current_date THEN 'expired'
                WHEN v.expiry_date_key<=(current_date+interval '3 months')::date THEN '3_months'
                WHEN v.expiry_date_key<=(current_date+interval '6 months')::date THEN '6_months'
                WHEN v.expiry_date_key<=(current_date+interval '9 months')::date THEN '9_months'
                ELSE NULL
              END AS expiry_bucket
            FROM visible v
          )
          SELECT jsonb_agg(jsonb_build_object(
            'name',s.row_name,
            'name_ar',s.row_name_ar,
            'unit',s.row_unit,
            'concentration',s.concentration,
            'dosage_form',s.dosage_form,
            'condition',s.effective_condition,
            'expiry_bucket',s.expiry_bucket,
            'quantity',CASE WHEN s.effective_condition='expired' THEN NULL ELSE s.available_quantity END,
            'expiry_date',CASE WHEN s.effective_condition IN ('near_expiry','expired') THEN s.expiry_date ELSE NULL END
          ) ORDER BY s.row_name_ar)
          FROM shaped s
        )
      ) INTO v_payload
      FROM public.distribution_points dp
      WHERE dp.id=v_target.target_id;

    WHEN 'warehouse' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.warehouses WHERE id=v_target.target_id AND status='active'
      ) THEN
        RETURN jsonb_build_object('ok',false,'error','WAREHOUSE_NOT_ACTIVE');
      END IF;

      SELECT jsonb_build_object(
        'ok',true,
        'target_type','warehouse',
        'org_name',v_org.name,
        'org_name_ar',v_org.name_ar,
        'warehouse_label',coalesce(v_target.label,wh.name),
        'points',(
          SELECT jsonb_agg(jsonb_build_object(
            'point_id',dp.id,
            'point_name',dp.name,
            'point_name_ar',dp.name_ar,
            'item_count',(
              WITH canonical AS (
                SELECT s.central_item_id,s.scientific_name,
                  coalesce(s.concentration,'') AS concentration_key,
                  coalesce(s.dosage_form,'') AS dosage_form_key,
                  coalesce(s.national_code,'') AS national_code_key,
                  coalesce(s.batch_number,'') AS batch_number_key,
                  coalesce(s.expiry_date,DATE '0001-01-01') AS expiry_date_key,
                  coalesce(s.internal_batch_reference,'') AS internal_ref_key,
                  sum(coalesce(s.available_quantity,0))::integer AS available_quantity
                FROM public.outlet_stock s
                WHERE s.distribution_point_id=dp.id
                GROUP BY s.central_item_id,s.scientific_name,
                  coalesce(s.concentration,''),coalesce(s.dosage_form,''),coalesce(s.national_code,''),
                  coalesce(s.batch_number,''),coalesce(s.expiry_date,DATE '0001-01-01'),
                  coalesce(s.internal_batch_reference,'')
              )
              SELECT count(*)::integer
              FROM canonical c
              WHERE c.available_quantity>0
                AND public.phoenix_derive_outlet_availability_condition(
                  c.available_quantity,NULLIF(c.expiry_date_key,DATE '0001-01-01'))<>'expired'
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.item_availability ia
                  LEFT JOIN public.local_items li_hidden ON li_hidden.id=ia.local_item_id
                  WHERE ia.distribution_point_id=dp.id
                    AND ia.removed_at IS NOT NULL
                    AND (
                      (c.central_item_id IS NOT NULL AND li_hidden.central_item_id=c.central_item_id)
                      OR coalesce(ia.scientific_name,'')=coalesce(c.scientific_name,'')
                    )
                    AND coalesce(ia.concentration,'')=c.concentration_key
                    AND coalesce(ia.dosage_form,'')=c.dosage_form_key
                    AND coalesce(ia.national_code,'')=c.national_code_key
                    AND coalesce(ia.batch_number,'')=c.batch_number_key
                    AND coalesce(ia.expiry_date,DATE '0001-01-01')=c.expiry_date_key
                    AND coalesce(ia.internal_batch_reference,'')=c.internal_ref_key
                )
            )
          ) ORDER BY dp.name_ar)
          FROM public.distribution_points dp
          WHERE dp.warehouse_id=wh.id AND dp.status='active'
        )
      ) INTO v_payload
      FROM public.warehouses wh
      WHERE wh.id=v_target.target_id;

    WHEN 'local_item' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.local_items WHERE id=v_target.target_id AND status='active'
      ) THEN
        RETURN jsonb_build_object('ok',false,'error','LOCAL_ITEM_NOT_ACTIVE');
      END IF;

      SELECT jsonb_build_object(
        'ok',true,
        'target_type','local_item',
        'org_name',v_org.name,
        'org_name_ar',v_org.name_ar,
        'item_name',ci.name,
        'item_name_ar',ci.name_ar,
        'unit',ci.unit,
        'availability',(
          WITH canonical AS (
            SELECT s.distribution_point_id,s.scientific_name,
              coalesce(s.concentration,'') AS concentration_key,
              coalesce(s.dosage_form,'') AS dosage_form_key,
              coalesce(s.national_code,'') AS national_code_key,
              coalesce(s.batch_number,'') AS batch_number_key,
              coalesce(s.expiry_date,DATE '0001-01-01') AS expiry_date_key,
              coalesce(s.internal_batch_reference,'') AS internal_ref_key,
              sum(coalesce(s.available_quantity,0))::integer AS available_quantity
            FROM public.outlet_stock s
            WHERE s.organization_id=v_target.organization_id
              AND s.central_item_id=li.central_item_id
            GROUP BY s.distribution_point_id,s.scientific_name,
              coalesce(s.concentration,''),coalesce(s.dosage_form,''),coalesce(s.national_code,''),
              coalesce(s.batch_number,''),coalesce(s.expiry_date,DATE '0001-01-01'),
              coalesce(s.internal_batch_reference,'')
          ), visible AS (
            SELECT c.*,dp.name AS point_name,dp.name_ar AS point_name_ar,
              public.phoenix_derive_outlet_availability_condition(
                c.available_quantity,NULLIF(c.expiry_date_key,DATE '0001-01-01')) AS effective_condition
            FROM canonical c
            JOIN public.distribution_points dp ON dp.id=c.distribution_point_id AND dp.status='active'
            WHERE NOT EXISTS (
              SELECT 1
              FROM public.item_availability ia
              LEFT JOIN public.local_items li_hidden ON li_hidden.id=ia.local_item_id
              WHERE ia.distribution_point_id=c.distribution_point_id
                AND ia.removed_at IS NOT NULL
                AND (
                  ia.local_item_id=li.id
                  OR (li_hidden.central_item_id=li.central_item_id)
                  OR coalesce(ia.scientific_name,'')=coalesce(c.scientific_name,'')
                )
                AND coalesce(ia.concentration,'')=c.concentration_key
                AND coalesce(ia.dosage_form,'')=c.dosage_form_key
                AND coalesce(ia.national_code,'')=c.national_code_key
                AND coalesce(ia.batch_number,'')=c.batch_number_key
                AND coalesce(ia.expiry_date,DATE '0001-01-01')=c.expiry_date_key
                AND coalesce(ia.internal_batch_reference,'')=c.internal_ref_key
            )
          ), shaped AS (
            SELECT v.*,
              NULLIF(v.expiry_date_key,DATE '0001-01-01') AS expiry_date,
              CASE
                WHEN v.expiry_date_key=DATE '0001-01-01' THEN NULL
                WHEN v.expiry_date_key<current_date THEN 'expired'
                WHEN v.expiry_date_key<=(current_date+interval '3 months')::date THEN '3_months'
                WHEN v.expiry_date_key<=(current_date+interval '6 months')::date THEN '6_months'
                WHEN v.expiry_date_key<=(current_date+interval '9 months')::date THEN '9_months'
                ELSE NULL
              END AS expiry_bucket
            FROM visible v
          )
          SELECT jsonb_agg(jsonb_build_object(
            'point_name',s.point_name,
            'point_name_ar',s.point_name_ar,
            'concentration',NULLIF(s.concentration_key,''),
            'dosage_form',NULLIF(s.dosage_form_key,''),
            'condition',s.effective_condition,
            'expiry_bucket',s.expiry_bucket,
            'quantity',CASE WHEN s.effective_condition='expired' THEN NULL ELSE s.available_quantity END,
            'expiry_date',CASE WHEN s.effective_condition IN ('near_expiry','expired') THEN s.expiry_date ELSE NULL END
          ) ORDER BY s.point_name_ar)
          FROM shaped s
        )
      ) INTO v_payload
      FROM public.local_items li
      JOIN public.central_items ci ON ci.id=li.central_item_id
      WHERE li.id=v_target.target_id;

    ELSE
      RETURN jsonb_build_object('ok',false,'error','UNKNOWN_TARGET_TYPE');
  END CASE;

  RETURN v_payload;
END;
$function$;

-- CREATE OR REPLACE preserves existing ACLs; make the three legitimate roles
-- explicit as a convergence guarantee for clean replay and hosted Production.
GRANT EXECUTE ON FUNCTION public.get_public_qr_payload(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_qr_payload(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_qr_payload(text) TO service_role;

COMMENT ON FUNCTION public.get_public_qr_payload(text) IS
  'STAGE-G-G2 / 177: public QR payload from canonical outlet_stock. item_availability is optional removed_at visibility metadata only; no cache quantity/condition is trusted. Public privacy fields and anonymous access are preserved.';

DO $verify$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.get_public_qr_payload(text)'::regprocedure) INTO v_def;

  IF NOT has_function_privilege('anon','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('authenticated','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('service_role','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION '177 verify failed: public QR execution contract changed';
  END IF;
  IF v_def NOT ILIKE '%FROM public.outlet_stock%'
     OR v_def ILIKE '%ia.quantity%'
     OR v_def ILIKE '%ia.condition%' THEN
    RAISE EXCEPTION '177 verify failed: QR does not use canonical stock exclusively';
  END IF;
  IF v_def NOT ILIKE '%removed_at IS NOT NULL%' THEN
    RAISE EXCEPTION '177 verify failed: catalogue visibility marker is not enforced';
  END IF;
  IF v_def NOT ILIKE '%scan_count = scan_count + 1%' THEN
    RAISE EXCEPTION '177 verify failed: scan counter side effect changed';
  END IF;
  IF v_def ~* $$'batch_number'\s*,$$
     OR v_def ~* $$'national_code'\s*,$$
     OR v_def ~* $$'price'\s*,$$
     OR v_def ~* $$'trade_name'\s*,$$
     OR v_def ~* $$'notes'\s*,$$
     OR v_def ~* $$'actor_(name|email|role|org)_snapshot'\s*, $$ THEN
    RAISE EXCEPTION '177 verify failed: sensitive/internal field entered public payload';
  END IF;
END;
$verify$;

COMMIT;