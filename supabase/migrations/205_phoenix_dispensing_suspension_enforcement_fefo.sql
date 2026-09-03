-- ============================================================================
-- DISPENSING-SUSPENSION-ENFORCEMENT-FEFO-205
--
-- Wires 203's suspension check into the single shared FEFO candidate engine,
-- _phoenix_inventory_fefo_batches_exact_v1 (150). This one function backs
-- every automated batch-selection path in the product: FEFO pick for patient
-- dispensing, and FEFO-guarded warehouse-transfer/dispatch line adds. Fixing
-- it here — rather than at each call site — is the same "smallest coherent
-- repair" precedent 150 itself used for the identity-key work.
--
-- Scope semantics match 203's helper exactly:
--   * warehouse-scope candidates check only an ORG-WIDE suspension (NULL
--     distribution_point passed) — warehouses have no distribution_point_id,
--     and a suspension scoped to one specific outlet has no meaning at the
--     warehouse level.
--   * outlet-scope candidates check org-wide OR that exact outlet.
--
-- A row with central_item_id IS NULL (unresolved identity) cannot match any
-- suspension and is therefore returned exactly as before — unchanged.
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
    RAISE EXCEPTION '205 PRECONDITION FAILED: 203 missing — apply 203 first';
  END IF;
END;
$precond$;

CREATE OR REPLACE FUNCTION public._phoenix_inventory_fefo_batches_exact_v1(
  p_organization_id uuid,
  p_scope_kind text,
  p_scope_id uuid,
  p_material_identity_key text
)
RETURNS TABLE(
  stock_id uuid, batch_number text, expiry_date date,
  available_quantity integer, transferable_quantity integer,
  dispatch_line_id uuid, inbound_movement_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_scope_kind NOT IN ('warehouse', 'outlet') THEN
    RAISE EXCEPTION 'invalid_scope_kind' USING ERRCODE = '23514';
  END IF;
  IF p_material_identity_key IS NULL THEN
    RAISE EXCEPTION 'material_identity_required' USING ERRCODE = '23514';
  END IF;
  IF p_scope_kind = 'warehouse' THEN
    RETURN QUERY
    SELECT ws.id,ws.batch_number,ws.expiry_date,ws.available_quantity,
           ws.available_quantity,NULL::uuid,NULL::uuid
    FROM public.warehouse_stock ws
    WHERE ws.organization_id=p_organization_id
      AND ws.warehouse_id=p_scope_id
      AND ws.material_identity_key=p_material_identity_key
      AND ws.available_quantity>0
      AND (ws.expiry_date IS NULL OR ws.expiry_date>=current_date)
      -- 205: موقوف الصرف — org-wide suspension only; warehouses carry no
      -- distribution_point_id for a point-scoped suspension to match against.
      AND (ws.central_item_id IS NULL OR NOT public._phoenix_is_material_dispensing_suspended_v1(
            ws.central_item_id, ws.organization_id, NULL
          ))
    ORDER BY ws.expiry_date ASC NULLS LAST,ws.id ASC;
  ELSE
    RETURN QUERY
    SELECT os.id,os.batch_number,os.expiry_date,os.available_quantity,
           LEAST(os.available_quantity,
                 COALESCE(wdl.received_quantity,0)-wdl.returned_quantity),
           wdl.id,osm.id
    FROM public.outlet_stock os
    JOIN public.warehouse_dispatch_lines wdl
      ON wdl.resulting_outlet_stock_id=os.id
     AND wdl.organization_id=os.organization_id
     AND wdl.status IN ('accepted','accepted_with_difference')
    JOIN public.outlet_stock_movements osm
      ON osm.dispatch_line_id=wdl.id
     AND osm.movement_type='dispatch_receive'
     AND osm.outlet_stock_id=os.id
     AND osm.organization_id=os.organization_id
    WHERE os.organization_id=p_organization_id
      AND os.distribution_point_id=p_scope_id
      AND os.material_identity_key=p_material_identity_key
      AND os.available_quantity>0
      AND (os.expiry_date IS NULL OR os.expiry_date>=current_date)
      AND COALESCE(wdl.received_quantity,0)-wdl.returned_quantity>0
      -- 205: موقوف الصرف — org-wide OR this exact outlet.
      AND (os.central_item_id IS NULL OR NOT public._phoenix_is_material_dispensing_suspended_v1(
            os.central_item_id, os.organization_id, os.distribution_point_id
          ))
    ORDER BY os.expiry_date ASC NULLS LAST,os.id ASC,wdl.id ASC;
  END IF;
END;
$$;

DO $verify$
BEGIN
  IF to_regprocedure('public._phoenix_inventory_fefo_batches_exact_v1(uuid,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION '205 VERIFY FAILED: _phoenix_inventory_fefo_batches_exact_v1 missing after redefinition';
  END IF;
  RAISE NOTICE 'DISPENSING-SUSPENSION-ENFORCEMENT-FEFO-205: verified.';
END;
$verify$;
