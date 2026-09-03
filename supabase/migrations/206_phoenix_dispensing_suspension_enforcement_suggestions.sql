-- ============================================================================
-- DISPENSING-SUSPENSION-ENFORCEMENT-SUGGESTIONS-206
--
-- Wires 203's suspension check into the two transfer-suggestion RPCs so an
-- actively suspended material is never proposed as either the source or an
-- implicit target of an "ordinary transfer suggestion" (task requirement).
-- Only the physical-batch candidate pools gain the filter; the alert-derived
-- need/surplus signals (_need150/_src150) are left untouched — suppressing
-- those would hide the underlying shortage/surplus signal itself, which is
-- not what suspension means. Suspension removes a material from the pool of
-- batches eligible to be *moved*, not from the reporting/alerting layer.
--
-- phoenix_suggest_inventory_transfers (intra-org): filter added to _batch150's
-- two UNION ALL branches (warehouse_stock, outlet_stock) — identical scope
-- semantics to 205 (org-wide for warehouse rows; org-wide-or-that-outlet for
-- outlet rows).
--
-- phoenix_suggest_cross_org_inventory_transfer: filter added to its single
-- warehouse_stock batch loop (org-wide only — this path only ever sources from
-- a warehouse).
--
-- Everything else in both bodies is byte-for-byte identical to 150's
-- definitions; only the filter lines are added.
--
-- PRECONDITIONS: 203 applied.
-- ============================================================================

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = '_phoenix_is_material_dispensing_suspended_v1'
       AND p.pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION '206 PRECONDITION FAILED: 203 missing — apply 203 first';
  END IF;
END;
$precond$;

CREATE OR REPLACE FUNCTION public.phoenix_suggest_inventory_transfers(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_is_super boolean;
  v_need record;
  v_src record;
  v_batch record;
  v_take integer;
  v_need_remaining integer;
  v_src_remaining integer;
  v_upserted integer := 0;
  v_rows integer;
  v_key text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  v_is_super:=(public.phoenix_my_role()='super_admin');
  PERFORM pg_advisory_xact_lock(
    hashtextextended('inv_suggest:' || p_organization_id::text,0)
  );

  CREATE TEMP TABLE _scopes150 (
    scope_kind text,scope_id uuid,PRIMARY KEY(scope_kind,scope_id)
  ) ON COMMIT DROP;
  INSERT INTO _scopes150
  SELECT 'warehouse',w.id FROM public.warehouses w
  WHERE w.organization_id=p_organization_id
    AND (v_is_super OR public.phoenix_profile_has_scoped_permission(
      v_actor,'inventory.suggest_transfers',p_organization_id,w.id,NULL))
  UNION ALL
  SELECT 'outlet',dp.id FROM public.distribution_points dp
  WHERE dp.organization_id=p_organization_id
    AND (v_is_super OR public.phoenix_profile_has_scoped_permission(
      v_actor,'inventory.suggest_transfers',p_organization_id,NULL,dp.id));
  IF NOT EXISTS(SELECT 1 FROM _scopes150) THEN
    RAISE EXCEPTION 'not_authorized_inventory_suggest';
  END IF;

  UPDATE public.inventory_transfer_suggestions s
  SET status='expired',updated_at=now()
  WHERE s.source_organization_id=p_organization_id
    AND s.target_organization_id=p_organization_id AND s.status='open'
    AND EXISTS(SELECT 1 FROM _scopes150 sc
      WHERE sc.scope_kind=s.source_scope_kind AND sc.scope_id=s.source_scope_id)
    AND EXISTS(SELECT 1 FROM _scopes150 sc
      WHERE sc.scope_kind=s.target_scope_kind AND sc.scope_id=s.target_scope_id)
    AND NOT EXISTS(
      SELECT 1 FROM public.phoenix_inventory_suggestion_commitments(s.id) c
      WHERE c.commitment_state='open_fresh'
    );

  CREATE TEMP TABLE _need150 ON COMMIT DROP AS
  SELECT a.id AS alert_id,a.scope_kind,a.scope_id,a.scientific_name,
         a.national_code,a.central_item_id,a.concentration,a.dosage_form,a.unit,
         a.material_identity_key,
         greatest(coalesce(a.threshold_reorder_point,0)
                    -coalesce(a.observed_available,0),1) AS deficit,
         greatest(coalesce(a.threshold_reorder_point,0)
                    -coalesce(a.observed_available,0),1)
           -coalesce((
             SELECT sum(c.target_commitment)
             FROM public.inventory_transfer_suggestions s
             CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
             WHERE s.target_scope_kind=a.scope_kind AND s.target_scope_id=a.scope_id
               AND s.target_organization_id=a.organization_id
               AND s.material_identity_state='resolved'
               AND s.material_identity_key=a.material_identity_key AND c.is_active
           ),0) AS remaining,
         CASE a.severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END AS prio
  FROM public.inventory_alerts a
  WHERE a.organization_id=p_organization_id
    AND a.material_identity_state='resolved'
    AND a.status IN ('open','acknowledged','in_progress')
    AND a.signal_type IN ('missing','low_stock')
    AND EXISTS(SELECT 1 FROM _scopes150 sc
      WHERE sc.scope_kind=a.scope_kind AND sc.scope_id=a.scope_id);

  CREATE TEMP TABLE _src150 ON COMMIT DROP AS
  SELECT a.id AS alert_id,a.scope_kind,a.scope_id,a.scientific_name,
         a.national_code,a.central_item_id,a.concentration,a.dosage_form,a.unit,
         a.material_identity_key,
         greatest(coalesce(a.observed_available,0)
                    -coalesce(a.threshold_target_max,0),0) AS headroom,
         greatest(coalesce(a.observed_available,0)
                    -coalesce(a.threshold_target_max,0),0)
           -coalesce((
             SELECT sum(c.source_commitment)
             FROM public.inventory_transfer_suggestions s
             CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
             WHERE s.source_scope_kind=a.scope_kind AND s.source_scope_id=a.scope_id
               AND s.source_organization_id=a.organization_id
               AND s.material_identity_state='resolved'
               AND s.material_identity_key=a.material_identity_key AND c.is_active
           ),0) AS remaining
  FROM public.inventory_alerts a
  WHERE a.organization_id=p_organization_id
    AND a.material_identity_state='resolved'
    AND a.status IN ('open','acknowledged','in_progress')
    AND a.signal_type='surplus'
    AND EXISTS(SELECT 1 FROM _scopes150 sc
      WHERE sc.scope_kind=a.scope_kind AND sc.scope_id=a.scope_id);

  CREATE TEMP TABLE _batch150 ON COMMIT DROP AS
  SELECT b.*,b.transferable_quantity-coalesce((
    SELECT sum(CASE WHEN b.dispatch_line_id IS NULL
                    THEN c.batch_commitment ELSE c.provenance_commitment END)
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
    WHERE s.source_stock_id=b.stock_id
      AND s.provenance_dispatch_line_id IS NOT DISTINCT FROM b.dispatch_line_id
      AND c.is_active
  ),0) AS remaining
  FROM (
    SELECT 'warehouse'::text AS scope_kind,ws.warehouse_id AS scope_id,
           ws.material_identity_key,ws.id AS stock_id,ws.batch_number,
           ws.expiry_date,ws.available_quantity,
           ws.available_quantity AS transferable_quantity,
           NULL::uuid AS dispatch_line_id,NULL::uuid AS inbound_movement_id
    FROM public.warehouse_stock ws
    WHERE ws.organization_id=p_organization_id AND ws.available_quantity>0
      AND (ws.expiry_date IS NULL OR ws.expiry_date>=current_date)
      AND EXISTS(SELECT 1 FROM _scopes150 sc
        WHERE sc.scope_kind='warehouse' AND sc.scope_id=ws.warehouse_id)
      -- 206: موقوف الصرف — org-wide suspension only (no distribution_point at
      -- warehouse scope).
      AND (ws.central_item_id IS NULL OR NOT public._phoenix_is_material_dispensing_suspended_v1(
            ws.central_item_id, ws.organization_id, NULL
          ))
    UNION ALL
    SELECT 'outlet',os.distribution_point_id,os.material_identity_key,os.id,
           os.batch_number,os.expiry_date,os.available_quantity,
           least(os.available_quantity,
                 coalesce(wdl.received_quantity,0)-wdl.returned_quantity),
           wdl.id,osm.id
    FROM public.outlet_stock os
    JOIN public.warehouse_dispatch_lines wdl
      ON wdl.resulting_outlet_stock_id=os.id
     AND wdl.organization_id=os.organization_id
     AND wdl.status IN ('accepted','accepted_with_difference')
    JOIN public.outlet_stock_movements osm
      ON osm.dispatch_line_id=wdl.id AND osm.movement_type='dispatch_receive'
     AND osm.outlet_stock_id=os.id AND osm.organization_id=os.organization_id
    WHERE os.organization_id=p_organization_id AND os.available_quantity>0
      AND (os.expiry_date IS NULL OR os.expiry_date>=current_date)
      AND (coalesce(wdl.received_quantity,0)-wdl.returned_quantity)>0
      AND EXISTS(SELECT 1 FROM _scopes150 sc
        WHERE sc.scope_kind='outlet' AND sc.scope_id=os.distribution_point_id)
      -- 206: موقوف الصرف — org-wide OR this exact outlet.
      AND (os.central_item_id IS NULL OR NOT public._phoenix_is_material_dispensing_suspended_v1(
            os.central_item_id, os.organization_id, os.distribution_point_id
          ))
  ) b;

  CREATE TEMP TABLE _stock_cap150 ON COMMIT DROP AS
  SELECT b.stock_id,max(b.available_quantity)-coalesce((
    SELECT sum(c.batch_commitment)
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
    WHERE s.source_stock_id=b.stock_id AND c.is_active
  ),0) AS remaining
  FROM _batch150 b GROUP BY b.stock_id;

  FOR v_need IN
    SELECT * FROM _need150 WHERE remaining>0
    ORDER BY prio DESC,material_identity_key,scope_id,alert_id
  LOOP
    v_need_remaining:=v_need.remaining;
    FOR v_src IN
      SELECT s.*,CASE
        WHEN s.scope_kind='warehouse' AND v_need.scope_kind='outlet'
          AND EXISTS(SELECT 1 FROM public.distribution_points dp
            WHERE dp.id=v_need.scope_id AND dp.warehouse_id=s.scope_id
              AND dp.organization_id=p_organization_id)
          THEN 'warehouse_to_outlet'
        WHEN s.scope_kind='outlet' AND v_need.scope_kind='warehouse'
          AND EXISTS(SELECT 1 FROM public.distribution_points dp
            WHERE dp.id=s.scope_id AND dp.warehouse_id=v_need.scope_id
              AND dp.organization_id=p_organization_id)
          THEN 'outlet_to_warehouse'
        WHEN s.scope_kind='warehouse' AND v_need.scope_kind='warehouse'
          AND EXISTS(SELECT 1 FROM public.warehouses sw
            WHERE sw.id=s.scope_id AND sw.warehouse_kind='central'
              AND sw.status='active')
          AND EXISTS(SELECT 1 FROM public.warehouses tw
            WHERE tw.id=v_need.scope_id AND tw.warehouse_kind='institution'
              AND tw.status='active')
          THEN 'central_to_institution'
        ELSE NULL END AS route_kind
      FROM _src150 s
      WHERE s.remaining>0
        AND s.material_identity_key=v_need.material_identity_key
        AND NOT(s.scope_kind=v_need.scope_kind AND s.scope_id=v_need.scope_id)
      ORDER BY s.remaining DESC,s.scope_id,s.alert_id
    LOOP
      EXIT WHEN v_need_remaining<=0;
      CONTINUE WHEN v_src.route_kind IS NULL;
      SELECT remaining INTO v_src_remaining FROM _src150
      WHERE alert_id=v_src.alert_id;
      CONTINUE WHEN v_src_remaining<=0;

      FOR v_batch IN
        SELECT b.*,sc.remaining AS stock_remaining
        FROM _batch150 b JOIN _stock_cap150 sc ON sc.stock_id=b.stock_id
        WHERE b.scope_kind=v_src.scope_kind AND b.scope_id=v_src.scope_id
          AND b.material_identity_key=v_src.material_identity_key
          AND b.remaining>0 AND sc.remaining>0
        ORDER BY b.expiry_date ASC NULLS LAST,b.stock_id,
                 coalesce(b.dispatch_line_id,
                   '00000000-0000-0000-0000-000000000000'::uuid)
      LOOP
        EXIT WHEN v_need_remaining<=0 OR v_src_remaining<=0;
        CONTINUE WHEN v_src.route_kind='outlet_to_warehouse'
                      AND v_batch.dispatch_line_id IS NULL;
        v_take:=least(v_need_remaining,v_src_remaining,
                      v_batch.remaining,v_batch.stock_remaining);
        CONTINUE WHEN v_take<=0;

        v_key:=p_organization_id::text || '|' || v_src.scope_kind || '|'
          || v_src.scope_id::text || '|' || v_need.scope_kind || '|'
          || v_need.scope_id::text || '|' || v_need.material_identity_key
          || '|' || v_batch.stock_id::text || '|'
          || coalesce(v_batch.dispatch_line_id::text,'');

        INSERT INTO public.inventory_transfer_suggestions AS su (
          source_organization_id,target_organization_id,scientific_name,national_code,
          central_item_id,concentration,dosage_form,unit,
          material_identity_version,material_identity_key,material_identity_state,
          source_scope_kind,source_scope_id,target_scope_kind,target_scope_id,route_kind,
          source_stock_id,suggested_quantity,fefo_batch_number,fefo_expiry_date,
          source_batch_available_snapshot,source_surplus_snapshot,
          target_shortfall_snapshot,provenance_dispatch_line_id,
          provenance_inbound_movement_id,rationale,suggestion_key,status,
          first_suggested_at,last_suggested_at,last_validated_at
        ) VALUES (
          p_organization_id,p_organization_id,v_need.scientific_name,
          v_need.national_code,v_need.central_item_id,v_need.concentration,
          v_need.dosage_form,v_need.unit,1,v_need.material_identity_key,'resolved',
          v_src.scope_kind,v_src.scope_id,v_need.scope_kind,v_need.scope_id,
          v_src.route_kind,v_batch.stock_id,v_take,v_batch.batch_number,
          v_batch.expiry_date,v_batch.available_quantity,v_src.headroom,
          v_need.deficit,
          CASE WHEN v_src.route_kind='outlet_to_warehouse'
               THEN v_batch.dispatch_line_id END,
          CASE WHEN v_src.route_kind='outlet_to_warehouse'
               THEN v_batch.inbound_movement_id END,
          'deterministic allocation: exact material identity and one FEFO batch',
          v_key,'open',now(),now(),now()
        )
        ON CONFLICT(suggestion_key) WHERE status='open' DO UPDATE SET
          suggested_quantity=EXCLUDED.suggested_quantity,
          route_kind=EXCLUDED.route_kind,
          fefo_batch_number=EXCLUDED.fefo_batch_number,
          fefo_expiry_date=EXCLUDED.fefo_expiry_date,
          source_batch_available_snapshot=EXCLUDED.source_batch_available_snapshot,
          source_surplus_snapshot=EXCLUDED.source_surplus_snapshot,
          target_shortfall_snapshot=EXCLUDED.target_shortfall_snapshot,
          provenance_inbound_movement_id=EXCLUDED.provenance_inbound_movement_id,
          last_suggested_at=now(),last_validated_at=now(),updated_at=now();
        GET DIAGNOSTICS v_rows=ROW_COUNT;
        CONTINUE WHEN v_rows=0;

        v_upserted:=v_upserted+1;
        v_need_remaining:=v_need_remaining-v_take;
        v_src_remaining:=v_src_remaining-v_take;
        UPDATE _src150 SET remaining=remaining-v_take WHERE alert_id=v_src.alert_id;
        UPDATE _batch150 SET remaining=remaining-v_take
        WHERE stock_id=v_batch.stock_id
          AND dispatch_line_id IS NOT DISTINCT FROM v_batch.dispatch_line_id
          AND scope_kind=v_batch.scope_kind AND scope_id=v_batch.scope_id;
        UPDATE _stock_cap150 SET remaining=remaining-v_take
        WHERE stock_id=v_batch.stock_id;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'organization_id',p_organization_id,'suggestions',v_upserted,'superseded',0
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_suggest_cross_org_inventory_transfer(
  p_source_organization_id uuid,
  p_source_warehouse_id uuid,
  p_target_organization_id uuid,
  p_target_warehouse_id uuid,
  p_scientific_name text,
  p_national_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid:=auth.uid();
  v_name text:=NULLIF(btrim(p_scientific_name),'');
  v_code text:=NULLIF(btrim(p_national_code),'');
  v_lock_a text;
  v_lock_b text;
  v_identity_count integer;
  v_material_key text;
  v_source record;
  v_target record;
  v_batch record;
  v_surplus integer;
  v_shortfall integer;
  v_batch_remaining integer;
  v_take integer;
  v_minted integer:=0;
  v_rows integer;
  v_key text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF public.phoenix_my_role()<>'super_admin' THEN
    RAISE EXCEPTION 'cross_org_suggestion_requires_super_admin';
  END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'scientific_name_required'; END IF;
  IF p_source_organization_id=p_target_organization_id THEN
    RAISE EXCEPTION 'use_intra_org_suggest_for_same_org';
  END IF;

  v_lock_a:=least(p_source_organization_id::text,p_target_organization_id::text);
  v_lock_b:=greatest(p_source_organization_id::text,p_target_organization_id::text);
  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_suggest:' || v_lock_a,'inv_suggest:' || v_lock_b
  ]);

  IF NOT EXISTS(
    SELECT 1 FROM public.warehouses sw
    JOIN public.warehouses tw ON tw.id=p_target_warehouse_id
    WHERE sw.id=p_source_warehouse_id AND sw.warehouse_kind='central'
      AND sw.status='active' AND sw.organization_id=p_source_organization_id
      AND tw.warehouse_kind='institution' AND tw.status='active'
      AND tw.organization_id=p_target_organization_id
  ) THEN RAISE EXCEPTION 'no_active_central_institution_pairing'; END IF;

  SELECT count(DISTINCT sa.material_identity_key),min(sa.material_identity_key)
    INTO v_identity_count,v_material_key
  FROM public.inventory_alerts sa
  WHERE sa.organization_id=p_source_organization_id
    AND sa.scope_kind='warehouse' AND sa.scope_id=p_source_warehouse_id
    AND sa.signal_type='surplus'
    AND sa.status IN ('open','acknowledged','in_progress')
    AND sa.material_identity_state='resolved'
    AND lower(btrim(sa.scientific_name))=lower(v_name)
    AND sa.national_code IS NOT DISTINCT FROM v_code
    AND EXISTS(
      SELECT 1 FROM public.inventory_alerts ta
      WHERE ta.organization_id=p_target_organization_id
        AND ta.scope_kind='warehouse' AND ta.scope_id=p_target_warehouse_id
        AND ta.signal_type IN ('missing','low_stock')
        AND ta.status IN ('open','acknowledged','in_progress')
        AND ta.material_identity_state='resolved'
        AND ta.material_identity_key=sa.material_identity_key
    );
  IF v_identity_count<>1 THEN RAISE EXCEPTION 'material_identity_ambiguous'; END IF;

  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_material:' || v_material_key
  ]);

  SELECT * INTO v_source FROM public.inventory_alerts a
  WHERE a.organization_id=p_source_organization_id
    AND a.scope_kind='warehouse' AND a.scope_id=p_source_warehouse_id
    AND a.signal_type='surplus' AND a.status IN ('open','acknowledged','in_progress')
    AND a.material_identity_state='resolved'
    AND a.material_identity_key=v_material_key
  ORDER BY a.last_observed_at DESC,a.id LIMIT 1;
  SELECT * INTO v_target FROM public.inventory_alerts a
  WHERE a.organization_id=p_target_organization_id
    AND a.scope_kind='warehouse' AND a.scope_id=p_target_warehouse_id
    AND a.signal_type IN ('missing','low_stock')
    AND a.status IN ('open','acknowledged','in_progress')
    AND a.material_identity_state='resolved'
    AND a.material_identity_key=v_material_key
  ORDER BY a.last_observed_at DESC,a.id LIMIT 1;

  v_surplus:=greatest(coalesce(v_source.observed_available,0)
                      -coalesce(v_source.threshold_target_max,0),0);
  v_shortfall:=greatest(coalesce(v_target.threshold_reorder_point,0)
                        -coalesce(v_target.observed_available,0),1);
  IF v_surplus<=0 THEN RAISE EXCEPTION 'no_source_surplus'; END IF;
  IF v_shortfall<=0 THEN RAISE EXCEPTION 'no_target_shortfall'; END IF;

  v_surplus:=v_surplus-coalesce((
    SELECT sum(c.source_commitment)
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id)c
    WHERE s.source_organization_id=p_source_organization_id
      AND s.source_scope_kind='warehouse' AND s.source_scope_id=p_source_warehouse_id
      AND s.material_identity_state='resolved'
      AND s.material_identity_key=v_material_key AND c.is_active
  ),0);
  v_shortfall:=v_shortfall-coalesce((
    SELECT sum(c.target_commitment)
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id)c
    WHERE s.target_organization_id=p_target_organization_id
      AND s.target_scope_kind='warehouse' AND s.target_scope_id=p_target_warehouse_id
      AND s.material_identity_state='resolved'
      AND s.material_identity_key=v_material_key AND c.is_active
  ),0);
  IF v_surplus<=0 THEN RAISE EXCEPTION 'source_surplus_already_committed'; END IF;
  IF v_shortfall<=0 THEN RAISE EXCEPTION 'target_shortfall_already_covered'; END IF;

  UPDATE public.inventory_transfer_suggestions s
  SET status='expired',updated_at=now()
  WHERE s.route_kind='central_to_institution'
    AND s.source_organization_id=p_source_organization_id
    AND s.target_organization_id=p_target_organization_id
    AND s.source_scope_id=p_source_warehouse_id
    AND s.target_scope_id=p_target_warehouse_id
    AND s.material_identity_key=v_material_key AND s.status='open'
    AND NOT EXISTS(
      SELECT 1 FROM public.phoenix_inventory_suggestion_commitments(s.id)c
      WHERE c.commitment_state='open_fresh'
    );

  FOR v_batch IN
    SELECT ws.* FROM public.warehouse_stock ws
    WHERE ws.organization_id=p_source_organization_id
      AND ws.warehouse_id=p_source_warehouse_id
      AND ws.material_identity_key=v_material_key AND ws.available_quantity>0
      AND (ws.expiry_date IS NULL OR ws.expiry_date>=current_date)
      -- 206: موقوف الصرف — org-wide suspension only; this path only ever
      -- sources from a warehouse.
      AND (ws.central_item_id IS NULL OR NOT public._phoenix_is_material_dispensing_suspended_v1(
            ws.central_item_id, ws.organization_id, NULL
          ))
    ORDER BY ws.expiry_date ASC NULLS LAST,ws.id
  LOOP
    EXIT WHEN v_surplus<=0 OR v_shortfall<=0;
    v_batch_remaining:=v_batch.available_quantity-coalesce((
      SELECT sum(c.batch_commitment)
      FROM public.inventory_transfer_suggestions s
      CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id)c
      WHERE s.source_stock_id=v_batch.id AND c.is_active
    ),0);
    CONTINUE WHEN v_batch_remaining<=0;
    v_take:=least(v_surplus,v_shortfall,v_batch_remaining);
    CONTINUE WHEN v_take<=0;

    v_key:='xorg|' || p_source_warehouse_id::text || '|'
      || p_target_warehouse_id::text || '|' || v_material_key || '|'
      || v_batch.id::text;
    INSERT INTO public.inventory_transfer_suggestions AS su (
      source_organization_id,target_organization_id,scientific_name,national_code,
      central_item_id,concentration,dosage_form,unit,
      material_identity_version,material_identity_key,material_identity_state,
      source_scope_kind,source_scope_id,target_scope_kind,target_scope_id,route_kind,
      source_stock_id,suggested_quantity,fefo_batch_number,fefo_expiry_date,
      source_batch_available_snapshot,source_surplus_snapshot,
      target_shortfall_snapshot,rationale,suggestion_key,status,
      first_suggested_at,last_suggested_at,last_validated_at
    ) VALUES (
      p_source_organization_id,p_target_organization_id,v_batch.scientific_name,
      v_batch.national_code,v_batch.central_item_id,v_batch.concentration,
      v_batch.dosage_form,v_batch.unit,1,v_material_key,'resolved',
      'warehouse',p_source_warehouse_id,'warehouse',p_target_warehouse_id,
      'central_to_institution',v_batch.id,v_take,v_batch.batch_number,
      v_batch.expiry_date,v_batch.available_quantity,
      greatest(coalesce(v_source.observed_available,0)
               -coalesce(v_source.threshold_target_max,0),0),
      greatest(coalesce(v_target.threshold_reorder_point,0)
               -coalesce(v_target.observed_available,0),1),
      'cross-org recommendation: exact canonical material and one FEFO batch',
      v_key,'open',now(),now(),now()
    )
    ON CONFLICT(suggestion_key) WHERE status='open' DO UPDATE SET
      suggested_quantity=EXCLUDED.suggested_quantity,
      fefo_batch_number=EXCLUDED.fefo_batch_number,
      fefo_expiry_date=EXCLUDED.fefo_expiry_date,
      source_batch_available_snapshot=EXCLUDED.source_batch_available_snapshot,
      source_surplus_snapshot=EXCLUDED.source_surplus_snapshot,
      target_shortfall_snapshot=EXCLUDED.target_shortfall_snapshot,
      last_suggested_at=now(),last_validated_at=now(),updated_at=now();
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    CONTINUE WHEN v_rows=0;
    v_minted:=v_minted+1;
    v_surplus:=v_surplus-v_take;
    v_shortfall:=v_shortfall-v_take;
  END LOOP;
  IF v_minted=0 THEN RAISE EXCEPTION 'no_eligible_fefo_batch'; END IF;
  RETURN jsonb_build_object(
    'route_kind','central_to_institution','suggestions',v_minted
  );
END;
$$;

DO $verify$
BEGIN
  IF to_regprocedure('public.phoenix_suggest_inventory_transfers(uuid)') IS NULL THEN
    RAISE EXCEPTION '206 VERIFY FAILED: phoenix_suggest_inventory_transfers missing after redefinition';
  END IF;
  IF to_regprocedure(
    'public.phoenix_suggest_cross_org_inventory_transfer(uuid,uuid,uuid,uuid,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION '206 VERIFY FAILED: phoenix_suggest_cross_org_inventory_transfer missing after redefinition';
  END IF;
  RAISE NOTICE 'DISPENSING-SUSPENSION-ENFORCEMENT-SUGGESTIONS-206: verified.';
END;
$verify$;
