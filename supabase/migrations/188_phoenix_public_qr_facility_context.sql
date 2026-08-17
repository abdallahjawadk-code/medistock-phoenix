-- ============================================================================
-- QR-FACILITY-CONTEXT-188 — PUBLIC QR CANONICAL FACILITY CONTEXT
--
-- Forward replacement of public.get_public_qr_payload(text) (Migration 177)
-- adding the CANONICAL structural facility (Health Center) context to the two
-- physical targets, plus one deliberate anonymous-surface reduction.
--
-- 1. FACILITY CONTEXT (additive public fields)
--    Health Center  = organization_facilities row  (NEVER inferred from names)
--    Health Sector  = organizations row (institution_class = 'health_sector')
--    The server derives ancestry from CURRENT canonical rows on every request:
--      distribution_points.warehouse_id
--        -> warehouses.facility_id
--        -> organization_facilities(id, organization_id)      [composite FK 164]
--    and emits facility_id / facility_name / facility_name_ar on the
--    distribution_point and warehouse targets. The fields are JSON null when
--    the chain has no ACTIVE facility hop:
--      * point with warehouse_id NULL              -> null (no fabrication)
--      * warehouse with facility_id NULL           -> null (sector main,
--        hospital / specialized-center / central root warehouses)
--      * facility or parent warehouse not active   -> null (fail-safe: an
--        inactive facility is never published as current Health Center
--        identity; display degrades, the target itself keeps its own
--        status contract)
--    local_item keeps its organization-scoped shape: it aggregates MANY points
--    and has no single canonical facility, so no facility fields are invented.
--
-- 2. TARGET LIFECYCLE FAIL-CLOSED
--    A qr_targets row whose status is not 'active' now resolves exactly like a
--    missing target (TARGET_NOT_FOUND, before the scan counter), instead of
--    silently rendering. No product writer ever sets qr_targets.status away
--    from 'active' today, so no live QR changes behavior; the previously
--    unreachable state simply fails closed.
--
-- 3. ANONYMOUS TOKEN-DIRECTORY CLOSURE
--    Migration 002 created qrtk_select_anon (SELECT on qr_tokens for anon,
--    USING status='active'), which lets the anonymous REST surface enumerate
--    every active public_id (documented as finding D5). The dependency census
--    for this migration found NO consumer: the public page resolves only
--    through get_public_qr_payload(public_id); every direct qr_tokens reader
--    (QR management list, lifecycle counts, dashboard counts) is an
--    authenticated session served by qrtk_select_org. The policy is dropped
--    and the anon table privilege revoked, so public QR stays reachable by a
--    possessed link/QR while the anonymous API stops being a directory of
--    active public_ids.
--
-- UNCHANGED, BY CONSTRUCTION
--    Signature, return type, SECURITY DEFINER, search_path, anon/authenticated/
--    service_role EXECUTE, token semantics, scan counter side effect, canonical
--    Migration-150 identity grouping, removal-marker fail-safe, per-identity
--    unit publication, public privacy curation, error vocabulary (no new error
--    string is distinguishable from the pre-existing ones).
--
-- NOT TOUCHED: Migration 187 delegated-access objects, HCM primary/facility
-- scopes, RLS on any table other than the one dropped anon policy, stock
-- writers, availability truth.
--
-- MANUAL APPLY ONLY. NEVER `supabase db push`.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.get_public_qr_payload(text)') IS NULL THEN
    RAISE EXCEPTION '188 preflight failed: public QR function missing';
  END IF;
  IF (SELECT count(*) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname = 'get_public_qr_payload') <> 1 THEN
    RAISE EXCEPTION '188 preflight failed: unexpected get_public_qr_payload overload';
  END IF;
  IF NOT has_function_privilege('anon','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('authenticated','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('service_role','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION '188 preflight failed: existing QR execution contract drifted';
  END IF;
  IF to_regclass('public.outlet_stock') IS NULL
     OR to_regclass('public.item_availability') IS NULL
     OR to_regclass('public.qr_tokens') IS NULL
     OR to_regclass('public.qr_targets') IS NULL
     OR to_regclass('public.organization_facilities') IS NULL THEN
    RAISE EXCEPTION '188 preflight failed: required tables missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouses' AND column_name='facility_id'
  ) THEN
    RAISE EXCEPTION '188 preflight failed: warehouses.facility_id missing (Migration 164)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='organization_facilities'
      AND column_name IN ('name','name_ar','status')
    HAVING count(*) = 3
  ) THEN
    RAISE EXCEPTION '188 preflight failed: organization_facilities identity columns missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='warehouses_facility_org_fk'
      AND conrelid='public.warehouses'::regclass AND contype='f'
  ) THEN
    RAISE EXCEPTION '188 preflight failed: canonical facility composite FK missing (Migration 164)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='distribution_points_wh_org_fk'
      AND conrelid='public.distribution_points'::regclass AND contype='f'
  ) THEN
    RAISE EXCEPTION '188 preflight failed: Hotfix-178 ownership FK missing';
  END IF;
  IF to_regprocedure('public._phoenix_material_identity_v1(uuid,text,text,text,text,text)') IS NULL
     OR to_regprocedure('public.phoenix_derive_outlet_availability_condition(integer,date)') IS NULL THEN
    RAISE EXCEPTION '188 preflight failed: canonical helpers missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='outlet_stock'
      AND column_name='material_identity_key' AND is_generated='ALWAYS'
  ) THEN
    RAISE EXCEPTION '188 preflight failed: canonical material identity column missing';
  END IF;
  -- The anon token-directory policy must still exist exactly once: this
  -- migration is the deliberate closure, and refusing to run against an
  -- already-diverged posture keeps the hardening unambiguous (175 idiom).
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname='public' AND tablename='qr_tokens'
        AND policyname='qrtk_select_anon') <> 1 THEN
    RAISE EXCEPTION '188 preflight failed: qrtk_select_anon not in expected pre-closure state';
  END IF;
  -- The authenticated org-scoped surfaces this closure must NOT touch.
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname='public' AND tablename='qr_tokens'
        AND policyname='qrtk_select_org') <> 1
     OR (SELECT count(*) FROM pg_policies
      WHERE schemaname='public' AND tablename='qr_targets'
        AND policyname='qrt_select_org') <> 1 THEN
    RAISE EXCEPTION '188 preflight failed: authenticated QR policies not in expected state';
  END IF;
  -- Migration 187 must already be applied and is deliberately untouched here.
  IF to_regclass('public.profile_delegated_scope_assignments') IS NULL
     OR to_regclass('public.delegated_operational_permission_keys') IS NULL
     OR to_regprocedure('public._phoenix_profile_has_delegated_scope_v1(uuid,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '188 preflight failed: Migration 187 baseline missing';
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
  -- QR-FACILITY-CONTEXT-188: canonical Health Center context, derived
  -- server-side from CURRENT structural rows only. All three stay NULL when
  -- the token-bound target has no active facility ancestor. The caller can
  -- supply nothing here: the only input remains p_public_id.
  v_facility_id      uuid;
  v_facility_name    text;
  v_facility_name_ar text;
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

  -- QR-FACILITY-CONTEXT-188: a non-active qr_target fails closed exactly like
  -- a missing one — same error, same position BEFORE the scan side effect, so
  -- the two states stay indistinguishable to an anonymous prober.
  IF v_target.status <> 'active' THEN
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

      -- QR-FACILITY-CONTEXT-188: point -> warehouse -> organization_facility.
      -- Every hop is a real FK (021/164/178) and every hop is re-read on every
      -- request, so a legally moved point follows its CURRENT ancestry and a
      -- snapshot/stale label can never be published. INNER joins + status
      -- predicates make every degraded shape (warehouse_id NULL, facility_id
      -- NULL, inactive warehouse, inactive facility) resolve to NULL fields
      -- rather than to a fabricated or stale Health Center. The organization
      -- pin is defense in depth on top of the composite FKs.
      SELECT f.id, f.name, f.name_ar
        INTO v_facility_id, v_facility_name, v_facility_name_ar
      FROM public.distribution_points dp
      JOIN public.warehouses w
        ON w.id = dp.warehouse_id
       AND w.organization_id = v_target.organization_id
       AND w.status = 'active'
      JOIN public.organization_facilities f
        ON f.id = w.facility_id
       AND f.organization_id = w.organization_id
       AND f.status = 'active'
      WHERE dp.id = v_target.target_id;

      SELECT jsonb_build_object(
        'ok',true,
        'target_type','distribution_point',
        'org_name',v_org.name,
        'org_name_ar',v_org.name_ar,
        'facility_id',v_facility_id,
        'facility_name',v_facility_name,
        'facility_name_ar',v_facility_name_ar,
        'point_label',coalesce(v_target.label,dp.name),
        'items',(
          -- Group on the canonical MATERIAL identity plus lot; aggregate only
          -- supply provenance. Display columns are constant inside a canonical
          -- group (they differ at most by case/whitespace, which 150 normalizes
          -- away), so min() is an exact, deterministic representative.
          WITH canonical AS (
            SELECT
              s.material_identity_key,
              s.central_item_id,
              min(public._phoenix_material_identity_v1(
                NULL,s.scientific_name,s.national_code,s.concentration,s.dosage_form,NULL
              )) AS projection_key,
              min(s.scientific_name) AS scientific_name,
              min(s.concentration) AS concentration,
              min(s.dosage_form) AS dosage_form,
              -- unit is a COMPONENT of material_identity_key, so it is constant
              -- within this group and min() is an exact representative. This is
              -- the unit the public row must publish — see row_unit below.
              min(s.unit) AS unit,
              coalesce(s.batch_number,'') AS batch_number_key,
              coalesce(s.expiry_date,DATE '0001-01-01') AS expiry_date_key,
              coalesce(s.internal_batch_reference,'') AS internal_ref_key,
              sum(coalesce(s.available_quantity,0))::integer AS available_quantity
            FROM public.outlet_stock s
            WHERE s.distribution_point_id=v_target.target_id
            -- central_item_id is a COMPONENT of material_identity_key, so it is
            -- constant inside a group and grouping by it cannot split one.
            GROUP BY s.material_identity_key,s.central_item_id,
              coalesce(s.batch_number,''),coalesce(s.expiry_date,DATE '0001-01-01'),
              coalesce(s.internal_batch_reference,'')
          ), markers AS (
            -- A removal marker can prove at most four material components plus
            -- the central item when it carries a local_item_id. Its projection
            -- is built by the CANONICAL helper (unit and central blanked), so
            -- comparison is exact and length-prefixed, never string-fuzzy.
            SELECT ia.id AS marker_id,
              li_hidden.central_item_id AS proven_central_item_id,
              public._phoenix_material_identity_v1(
                NULL,ia.scientific_name,ia.national_code,ia.concentration,ia.dosage_form,NULL
              ) AS projection_key,
              coalesce(ia.batch_number,'') AS batch_number_key,
              coalesce(ia.expiry_date,DATE '0001-01-01') AS expiry_date_key,
              coalesce(ia.internal_batch_reference,'') AS internal_ref_key
            FROM public.item_availability ia
            LEFT JOIN public.local_items li_hidden ON li_hidden.id=ia.local_item_id
            WHERE ia.distribution_point_id=v_target.target_id
              AND ia.removed_at IS NOT NULL
          ), hidden AS (
            -- min(...) over a HAVING count(DISTINCT ...)=1 group is 150's own
            -- idiom for "resolves to exactly one canonical identity".
            SELECT min(c.material_identity_key) AS material_identity_key,
              m.batch_number_key,m.expiry_date_key,m.internal_ref_key
            FROM markers m
            JOIN canonical c
              ON c.projection_key=m.projection_key
             AND c.batch_number_key=m.batch_number_key
             AND c.expiry_date_key=m.expiry_date_key
             AND c.internal_ref_key=m.internal_ref_key
             AND (m.proven_central_item_id IS NULL
                  OR m.proven_central_item_id=c.central_item_id)
            GROUP BY m.marker_id,m.batch_number_key,m.expiry_date_key,m.internal_ref_key
            HAVING count(DISTINCT c.material_identity_key)=1
          ), visible AS (
            -- central_items supplies DISPLAY NAMES only. Its `unit` is
            -- deliberately not carried here: see row_unit below.
            SELECT c.*,ci.name AS central_name,ci.name_ar AS central_name_ar,
              public.phoenix_derive_outlet_availability_condition(
                c.available_quantity,NULLIF(c.expiry_date_key,DATE '0001-01-01')) AS effective_condition
            FROM canonical c
            LEFT JOIN public.central_items ci ON ci.id=c.central_item_id
            WHERE NOT EXISTS (
              SELECT 1 FROM hidden h
              WHERE h.material_identity_key=c.material_identity_key
                AND h.batch_number_key=c.batch_number_key
                AND h.expiry_date_key=c.expiry_date_key
                AND h.internal_ref_key=c.internal_ref_key
            )
          ), shaped AS (
            SELECT
              coalesce(v.central_name,v.central_name_ar,v.scientific_name,'Unnamed material') AS row_name,
              coalesce(v.central_name_ar,v.central_name,v.scientific_name,'مادة غير مسماة') AS row_name_ar,
              -- Row-specific canonical unit, exactly as the local_item branch
              -- publishes it. unit is a COMPONENT of material_identity_key, so
              -- every row here IS one unit-distinct physical identity. Taking
              -- the catalogue unit in preference — which the pre-177 body did,
              -- correctly, because it read item_availability, which has no unit
              -- column at all — relabels 5 box + 3 strip as 5 box + 3 box and
              -- misstates physical stock on an anonymous public payload.
              --
              -- The catalogue unit is not a FALLBACK either. outlet_stock.unit
              -- is nullable (outlet_stock_unit_chk permits NULL and forbids
              -- ''), and under 150 a NULL unit is its own canonical identity
              -- via the 'N' sentinel — so borrowing the catalogue label for it
              -- would merge two distinct identities under one unit in exactly
              -- the same way. NULL here means "stock records no unit", and the
              -- public screen then renders the bare quantity.
              NULLIF(v.unit,'') AS row_unit,
              NULLIF(v.concentration,'') AS concentration,
              NULLIF(v.dosage_form,'') AS dosage_form,
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

      -- QR-FACILITY-CONTEXT-188: a Center Depot (facility-bound warehouse)
      -- publishes its Health Center; a sector main / hospital root /
      -- specialized-center root / central warehouse has facility_id NULL and
      -- publishes null fields. Same current-structure and fail-safe rules as
      -- the point branch above.
      SELECT f.id, f.name, f.name_ar
        INTO v_facility_id, v_facility_name, v_facility_name_ar
      FROM public.warehouses w
      JOIN public.organization_facilities f
        ON f.id = w.facility_id
       AND f.organization_id = w.organization_id
       AND f.status = 'active'
      WHERE w.id = v_target.target_id
        AND w.organization_id = v_target.organization_id;

      SELECT jsonb_build_object(
        'ok',true,
        'target_type','warehouse',
        'org_name',v_org.name,
        'org_name_ar',v_org.name_ar,
        'facility_id',v_facility_id,
        'facility_name',v_facility_name,
        'facility_name_ar',v_facility_name_ar,
        'warehouse_label',coalesce(v_target.label,wh.name),
        'points',(
          SELECT jsonb_agg(jsonb_build_object(
            'point_id',dp.id,
            'point_name',dp.name,
            'point_name_ar',dp.name_ar,
            'item_count',(
              -- Counts CANONICAL material identities. Grouping on
              -- material_identity_key keeps unit-distinct identities separate,
              -- so two units of one product are two public entries.
              WITH canonical AS (
                SELECT s.material_identity_key,
                  s.central_item_id,
                  min(public._phoenix_material_identity_v1(
                    NULL,s.scientific_name,s.national_code,s.concentration,s.dosage_form,NULL
                  )) AS projection_key,
                  coalesce(s.batch_number,'') AS batch_number_key,
                  coalesce(s.expiry_date,DATE '0001-01-01') AS expiry_date_key,
                  coalesce(s.internal_batch_reference,'') AS internal_ref_key,
                  sum(coalesce(s.available_quantity,0))::integer AS available_quantity
                FROM public.outlet_stock s
                WHERE s.distribution_point_id=dp.id
                GROUP BY s.material_identity_key,s.central_item_id,
                  coalesce(s.batch_number,''),coalesce(s.expiry_date,DATE '0001-01-01'),
                  coalesce(s.internal_batch_reference,'')
              ), markers AS (
                SELECT ia.id AS marker_id,
                  li_hidden.central_item_id AS proven_central_item_id,
                  public._phoenix_material_identity_v1(
                    NULL,ia.scientific_name,ia.national_code,ia.concentration,ia.dosage_form,NULL
                  ) AS projection_key,
                  coalesce(ia.batch_number,'') AS batch_number_key,
                  coalesce(ia.expiry_date,DATE '0001-01-01') AS expiry_date_key,
                  coalesce(ia.internal_batch_reference,'') AS internal_ref_key
                FROM public.item_availability ia
                LEFT JOIN public.local_items li_hidden ON li_hidden.id=ia.local_item_id
                WHERE ia.distribution_point_id=dp.id
                  AND ia.removed_at IS NOT NULL
              ), hidden AS (
                SELECT min(c.material_identity_key) AS material_identity_key,
                  m.batch_number_key,m.expiry_date_key,m.internal_ref_key
                FROM markers m
                JOIN canonical c
                  ON c.projection_key=m.projection_key
                 AND c.batch_number_key=m.batch_number_key
                 AND c.expiry_date_key=m.expiry_date_key
                 AND c.internal_ref_key=m.internal_ref_key
                 AND (m.proven_central_item_id IS NULL
                      OR m.proven_central_item_id=c.central_item_id)
                GROUP BY m.marker_id,m.batch_number_key,m.expiry_date_key,m.internal_ref_key
                HAVING count(DISTINCT c.material_identity_key)=1
              )
              SELECT count(*)::integer
              FROM canonical c
              WHERE c.available_quantity>0
                AND public.phoenix_derive_outlet_availability_condition(
                  c.available_quantity,NULLIF(c.expiry_date_key,DATE '0001-01-01'))<>'expired'
                AND NOT EXISTS (
                  SELECT 1 FROM hidden h
                  WHERE h.material_identity_key=c.material_identity_key
                    AND h.batch_number_key=c.batch_number_key
                    AND h.expiry_date_key=c.expiry_date_key
                    AND h.internal_ref_key=c.internal_ref_key
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
          -- Per point, per canonical MATERIAL identity, per lot. Unit-distinct
          -- identities are never summed into one physical quantity.
          WITH canonical AS (
            SELECT s.distribution_point_id,s.material_identity_key,
              s.central_item_id,
              min(public._phoenix_material_identity_v1(
                NULL,s.scientific_name,s.national_code,s.concentration,s.dosage_form,NULL
              )) AS projection_key,
              min(s.concentration) AS concentration,
              min(s.dosage_form) AS dosage_form,
              -- unit is a COMPONENT of material_identity_key, so it is constant
              -- within this group after 150's normalization and min() is an
              -- exact representative. Each availability row must carry the unit
              -- of ITS OWN canonical identity: a local item whose stock exists
              -- as both 'box' and 'strip' is two identities, and labelling both
              -- from central_items.unit would misreport physical quantities.
              min(s.unit) AS unit,
              coalesce(s.batch_number,'') AS batch_number_key,
              coalesce(s.expiry_date,DATE '0001-01-01') AS expiry_date_key,
              coalesce(s.internal_batch_reference,'') AS internal_ref_key,
              sum(coalesce(s.available_quantity,0))::integer AS available_quantity
            FROM public.outlet_stock s
            WHERE s.organization_id=v_target.organization_id
              AND s.central_item_id=li.central_item_id
            GROUP BY s.distribution_point_id,s.material_identity_key,s.central_item_id,
              coalesce(s.batch_number,''),coalesce(s.expiry_date,DATE '0001-01-01'),
              coalesce(s.internal_batch_reference,'')
          ), markers AS (
            SELECT ia.distribution_point_id,ia.id AS marker_id,
              li_hidden.central_item_id AS proven_central_item_id,
              public._phoenix_material_identity_v1(
                NULL,ia.scientific_name,ia.national_code,ia.concentration,ia.dosage_form,NULL
              ) AS projection_key,
              coalesce(ia.batch_number,'') AS batch_number_key,
              coalesce(ia.expiry_date,DATE '0001-01-01') AS expiry_date_key,
              coalesce(ia.internal_batch_reference,'') AS internal_ref_key
            FROM public.item_availability ia
            LEFT JOIN public.local_items li_hidden ON li_hidden.id=ia.local_item_id
            WHERE ia.removed_at IS NOT NULL
              AND ia.distribution_point_id IN (SELECT c.distribution_point_id FROM canonical c)
          ), hidden AS (
            SELECT m.distribution_point_id,
              min(c.material_identity_key) AS material_identity_key,
              m.batch_number_key,m.expiry_date_key,m.internal_ref_key
            FROM markers m
            JOIN canonical c
              ON c.distribution_point_id=m.distribution_point_id
             AND c.projection_key=m.projection_key
             AND c.batch_number_key=m.batch_number_key
             AND c.expiry_date_key=m.expiry_date_key
             AND c.internal_ref_key=m.internal_ref_key
             AND (m.proven_central_item_id IS NULL
                  OR m.proven_central_item_id=c.central_item_id)
            GROUP BY m.distribution_point_id,m.marker_id,
              m.batch_number_key,m.expiry_date_key,m.internal_ref_key
            HAVING count(DISTINCT c.material_identity_key)=1
          ), visible AS (
            SELECT c.*,dp.name AS point_name,dp.name_ar AS point_name_ar,
              public.phoenix_derive_outlet_availability_condition(
                c.available_quantity,NULLIF(c.expiry_date_key,DATE '0001-01-01')) AS effective_condition
            FROM canonical c
            JOIN public.distribution_points dp ON dp.id=c.distribution_point_id AND dp.status='active'
            WHERE NOT EXISTS (
              SELECT 1 FROM hidden h
              WHERE h.distribution_point_id=c.distribution_point_id
                AND h.material_identity_key=c.material_identity_key
                AND h.batch_number_key=c.batch_number_key
                AND h.expiry_date_key=c.expiry_date_key
                AND h.internal_ref_key=c.internal_ref_key
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
            -- Row-specific canonical unit. Deliberately NOT the top-level
            -- ci.unit, which would flatten unit-distinct identities to one
            -- label. NULL when stock carries no unit — the public screen then
            -- renders the bare quantity rather than an invented unit.
            'unit',NULLIF(s.unit,''),
            'concentration',NULLIF(s.concentration,''),
            'dosage_form',NULLIF(s.dosage_form,''),
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
  'QR-FACILITY-CONTEXT-188: Migration-177 canonical public QR payload plus server-derived structural Health Center context. distribution_point and warehouse targets carry facility_id/facility_name/facility_name_ar resolved on every request through distribution_points.warehouse_id -> warehouses.facility_id -> organization_facilities, active hops only; fields are null when the chain has no active facility (sector main, hospital/specialized/central roots, degraded ancestry). local_item stays organization-scoped. Non-active qr_targets fail closed as TARGET_NOT_FOUND. No caller-supplied ancestry; identity, grouping, privacy curation, scan accounting and anonymous EXECUTE are unchanged from 177.';

-- ── Anonymous token-directory closure ───────────────────────────────────────
-- Dependency census (see header): no anonymous consumer performs direct
-- SELECT on qr_tokens; the public page resolves exclusively through
-- get_public_qr_payload(public_id), and every management/dashboard reader is
-- an authenticated session served by qrtk_select_org. Possession of a QR/link
-- remains the only anonymous key; the directory of active public_ids closes.
DROP POLICY qrtk_select_anon ON public.qr_tokens;
REVOKE ALL ON TABLE public.qr_tokens FROM PUBLIC, anon;

DO $verify$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.get_public_qr_payload(text)'::regprocedure) INTO v_def;

  -- Exactly one overload, one text argument: no caller-supplied ancestry.
  IF (SELECT count(*) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname = 'get_public_qr_payload') <> 1 THEN
    RAISE EXCEPTION '188 verify failed: unexpected get_public_qr_payload overload appeared';
  END IF;
  IF (SELECT pronargs FROM pg_proc
      WHERE oid='public.get_public_qr_payload(text)'::regprocedure) <> 1 THEN
    RAISE EXCEPTION '188 verify failed: public QR arity changed';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
      WHERE oid='public.get_public_qr_payload(text)'::regprocedure) THEN
    RAISE EXCEPTION '188 verify failed: SECURITY DEFINER posture lost';
  END IF;
  IF v_def NOT ILIKE '%SET search_path TO %public%' AND v_def NOT ILIKE '%SET search_path = public%' THEN
    RAISE EXCEPTION '188 verify failed: search_path is not pinned';
  END IF;
  IF NOT has_function_privilege('anon','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('authenticated','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('service_role','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION '188 verify failed: public QR execution contract changed';
  END IF;

  -- Facility context is present, structural, active-only, and join-derived.
  IF v_def NOT ILIKE '%JOIN public.organization_facilities f%'
     OR v_def NOT ILIKE '%f.id = w.facility_id%'
     OR v_def NOT ILIKE '%f.organization_id = w.organization_id%'
     OR v_def NOT ILIKE '%f.status = ''active''%'
     OR v_def NOT ILIKE '%''facility_id'',v_facility_id%'
     OR v_def NOT ILIKE '%''facility_name'',v_facility_name%'
     OR v_def NOT ILIKE '%''facility_name_ar'',v_facility_name_ar%' THEN
    RAISE EXCEPTION '188 verify failed: canonical facility context missing from public QR';
  END IF;
  -- Structural only — never name-inferred.
  IF v_def ILIKE '%name ILIKE%' OR v_def ILIKE '%name_ar ILIKE%' OR v_def ILIKE '%SIMILAR TO%' THEN
    RAISE EXCEPTION '188 verify failed: name-based hierarchy inference detected';
  END IF;
  -- Target lifecycle fails closed before the scan side effect.
  IF v_def NOT ILIKE '%v_target.status <> ''active''%' THEN
    RAISE EXCEPTION '188 verify failed: non-active qr_target no longer fails closed';
  END IF;

  -- Migration 177 canonical-stock contract, carried forward verbatim.
  IF v_def NOT ILIKE '%FROM public.outlet_stock%'
     OR v_def ILIKE '%ia.quantity%'
     OR v_def ILIKE '%ia.condition%' THEN
    RAISE EXCEPTION '188 verify failed: QR does not use canonical stock exclusively';
  END IF;
  IF v_def NOT ILIKE '%GROUP BY s.material_identity_key%'
     OR v_def NOT ILIKE '%GROUP BY s.distribution_point_id,s.material_identity_key%' THEN
    RAISE EXCEPTION '188 verify failed: public grouping is not canonical material identity';
  END IF;
  IF v_def ILIKE '%OR coalesce(ia.scientific_name%' THEN
    RAISE EXCEPTION '188 verify failed: fuzzy catalogue removal matching reintroduced';
  END IF;
  IF v_def NOT ILIKE '%HAVING count(DISTINCT c.material_identity_key)=1%' THEN
    RAISE EXCEPTION '188 verify failed: ambiguous removal markers are not fail-safe';
  END IF;
  IF v_def NOT ILIKE $$%'unit',NULLIF(s.unit,'')%$$
     OR v_def NOT ILIKE '%min(s.unit) AS unit%' THEN
    RAISE EXCEPTION '188 verify failed: local_item availability rows lost their canonical unit';
  END IF;
  IF v_def NOT ILIKE $$%NULLIF(v.unit,'') AS row_unit%$$
     OR v_def ILIKE '%central_unit%' THEN
    RAISE EXCEPTION '188 verify failed: distribution_point rows lost their canonical unit';
  END IF;
  IF v_def NOT ILIKE '%removed_at IS NOT NULL%' THEN
    RAISE EXCEPTION '188 verify failed: catalogue visibility marker is not enforced';
  END IF;
  IF v_def NOT ILIKE '%scan_count = scan_count + 1%' THEN
    RAISE EXCEPTION '188 verify failed: scan counter side effect changed';
  END IF;
  IF v_def ~* $$'batch_number'\s*,$$
     OR v_def ~* $$'national_code'\s*,$$
     OR v_def ~* $$'price'\s*,$$
     OR v_def ~* $$'trade_name'\s*,$$
     OR v_def ~* $$'notes'\s*,$$
     OR v_def ~* $$'actor_(name|email|role|org)_snapshot'\s*, $$ THEN
    RAISE EXCEPTION '188 verify failed: sensitive/internal field entered public payload';
  END IF;

  -- The definer reaches the canonical identity helper; public roles never do.
  IF NOT has_function_privilege(
       (SELECT pg_get_userbyid(proowner) FROM pg_proc
        WHERE oid='public.get_public_qr_payload(text)'::regprocedure),
       'public._phoenix_material_identity_v1(uuid,text,text,text,text,text)'::regprocedure,
       'EXECUTE') THEN
    RAISE EXCEPTION '188 verify failed: definer cannot execute the canonical identity helper';
  END IF;
  IF has_function_privilege('anon',
       'public._phoenix_material_identity_v1(uuid,text,text,text,text,text)'::regprocedure,'EXECUTE')
     OR has_function_privilege('authenticated',
       'public._phoenix_material_identity_v1(uuid,text,text,text,text,text)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION '188 verify failed: internal identity helper was exposed to public roles';
  END IF;

  -- Migration 187 delegated-access surface is untouched and never consulted.
  IF v_def ILIKE '%delegated%'
     OR v_def ILIKE '%phoenix_profile_has_scoped_permission%' THEN
    RAISE EXCEPTION '188 verify failed: public QR coupled to delegated access';
  END IF;
  IF to_regclass('public.profile_delegated_scope_assignments') IS NULL
     OR to_regclass('public.delegated_operational_permission_keys') IS NULL
     OR to_regprocedure('public._phoenix_profile_has_delegated_scope_v1(uuid,uuid,uuid,uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_proc
        WHERE pronamespace='public'::regnamespace
          AND proname='phoenix_profile_has_scoped_permission') THEN
    RAISE EXCEPTION '188 verify failed: Migration 187 objects disturbed';
  END IF;
  IF has_table_privilege('anon','public.profile_delegated_scope_assignments','SELECT') THEN
    RAISE EXCEPTION '188 verify failed: delegated assignments exposed to anon';
  END IF;
  -- Historical primary scope objects untouched.
  IF to_regclass('public.profile_scope_assignments') IS NULL THEN
    RAISE EXCEPTION '188 verify failed: primary scope objects disturbed';
  END IF;

  -- Deliberate final token-table anon posture.
  IF EXISTS (SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename='qr_tokens'
        AND policyname='qrtk_select_anon') THEN
    RAISE EXCEPTION '188 verify failed: anon token-directory policy still present';
  END IF;
  IF has_table_privilege('anon','public.qr_tokens','SELECT')
     OR has_table_privilege('anon','public.qr_tokens','INSERT')
     OR has_table_privilege('anon','public.qr_tokens','UPDATE')
     OR has_table_privilege('anon','public.qr_tokens','DELETE') THEN
    RAISE EXCEPTION '188 verify failed: anon retains qr_tokens table privilege';
  END IF;
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname='public' AND tablename='qr_tokens'
        AND policyname='qrtk_select_org') <> 1
     OR (SELECT count(*) FROM pg_policies
      WHERE schemaname='public' AND tablename='qr_targets'
        AND policyname='qrt_select_org') <> 1 THEN
    RAISE EXCEPTION '188 verify failed: authenticated QR policies disturbed';
  END IF;
END;
$verify$;

COMMIT;
