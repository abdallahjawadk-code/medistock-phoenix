-- R1.1 / Migration 181 operator gate — READ ONLY.
-- Run against Production only through the authorized read-only channel.
-- This statement performs no DDL, DML, function call, lock, or migration write.
WITH health_sectors AS (
  SELECT o.id, o.name, o.name_ar, o.code, o.status
  FROM public.organizations o
  WHERE o.status = 'active' AND o.institution_class = 'health_sector'
),
facility_evidence AS (
  SELECT hs.id AS organization_id,
         count(f.*) AS facility_count,
         count(*) FILTER (WHERE f.status='active') AS active_facility_count,
         coalesce(jsonb_agg(jsonb_build_object(
           'id',f.id,'class',f.facility_class,'status',f.status,
           'name',f.name,'name_ar',f.name_ar,'code',f.code
         ) ORDER BY f.id) FILTER (WHERE f.id IS NOT NULL),'[]'::jsonb) AS facilities
  FROM health_sectors hs
  LEFT JOIN public.organization_facilities f ON f.organization_id=hs.id
  GROUP BY hs.id
),
warehouse_evidence AS (
  SELECT hs.id AS organization_id,
         count(w.*) AS warehouse_count,
         count(*) FILTER (WHERE w.status='active') AS active_warehouses,
         count(*) FILTER (WHERE w.status='active' AND w.warehouse_kind='institution'
                            AND w.facility_id IS NULL AND w.is_main) AS valid_sector_mains,
         count(*) FILTER (WHERE w.status='active' AND w.facility_id IS NULL) AS active_facility_null,
         count(*) FILTER (WHERE w.status='active' AND w.is_main) AS active_mains,
         count(*) FILTER (WHERE w.status='active' AND w.warehouse_kind='central') AS active_central,
         count(*) FILTER (WHERE w.status='active' AND w.facility_id IS NOT NULL) AS active_center_depots,
         count(*) FILTER (WHERE w.status='active' AND w.facility_id IS NOT NULL AND w.is_main) AS facility_bound_mains,
         count(*) FILTER (WHERE w.status='active' AND w.facility_id IS NULL AND NOT w.is_main) AS facility_null_nonmains,
         count(*) FILTER (WHERE w.status='active' AND w.facility_id IS NOT NULL AND
           (f.id IS NULL OR f.organization_id<>hs.id OR f.status<>'active' OR
            f.facility_class NOT IN ('primary_health_center','subordinate_health_center'))) AS invalid_facility_depots,
         coalesce(jsonb_agg(jsonb_build_object(
           'id',w.id,'name',w.name,'name_ar',w.name_ar,'code',w.code,
           'status',w.status,'warehouse_kind',w.warehouse_kind,
           'facility_id',w.facility_id,'is_main',w.is_main
         ) ORDER BY w.id) FILTER (WHERE w.id IS NOT NULL),'[]'::jsonb) AS warehouses
  FROM health_sectors hs
  LEFT JOIN public.warehouses w ON w.organization_id=hs.id
  LEFT JOIN public.organization_facilities f ON f.id=w.facility_id
  GROUP BY hs.id
),
duplicate_depots AS (
  SELECT hs.id AS organization_id, count(d.*) AS facilities_with_multiple_active_depots
  FROM health_sectors hs
  LEFT JOIN LATERAL (
    SELECT w.facility_id FROM public.warehouses w
    WHERE w.organization_id=hs.id AND w.status='active' AND w.facility_id IS NOT NULL
    GROUP BY w.facility_id HAVING count(*)>1
  ) d ON true
  GROUP BY hs.id
),
outlet_evidence AS (
  SELECT hs.id AS organization_id,
         count(dp.*) AS outlet_count,
         count(*) FILTER (WHERE dp.status='active') AS active_outlets,
         count(*) FILTER (WHERE dp.status='active' AND w.facility_id IS NULL) AS sector_level_outlets,
         count(*) FILTER (WHERE dp.status='active' AND dp.point_type='rescue_cart') AS rescue_carts,
         count(*) FILTER (WHERE dp.status='active' AND dp.point_type NOT IN ('pharmacy','crash_cabinet')) AS invalid_outlet_types,
         count(*) FILTER (WHERE dp.status='active' AND dp.point_type='crash_cabinet'
                            AND dp.clinical_location_kind IS DISTINCT FROM 'emergency') AS invalid_crash_contexts,
         coalesce(jsonb_agg(jsonb_build_object(
           'id',dp.id,'name',dp.name,'name_ar',dp.name_ar,'status',dp.status,
           'warehouse_id',dp.warehouse_id,'facility_id',w.facility_id,
           'point_type',dp.point_type,'clinical_location_kind',dp.clinical_location_kind
         ) ORDER BY dp.id) FILTER (WHERE dp.id IS NOT NULL),'[]'::jsonb) AS outlets
  FROM health_sectors hs
  LEFT JOIN public.distribution_points dp ON dp.organization_id=hs.id
  LEFT JOIN public.warehouses w ON w.id=dp.warehouse_id
  GROUP BY hs.id
),
operational_evidence AS (
  SELECT hs.id AS organization_id,
    (SELECT count(*) FROM public.warehouse_stock s JOIN public.warehouses w ON w.id=s.warehouse_id WHERE w.organization_id=hs.id) AS warehouse_stock_rows,
    (SELECT count(*) FROM public.outlet_stock s WHERE s.organization_id=hs.id) AS outlet_stock_rows,
    (SELECT count(*) FROM public.warehouse_stock_movements m JOIN public.warehouses w ON w.id=m.warehouse_id WHERE w.organization_id=hs.id) AS warehouse_movement_rows,
    (SELECT count(*) FROM public.outlet_stock_movements m WHERE m.organization_id=hs.id) AS outlet_movement_rows,
    (SELECT count(*) FROM public.warehouse_dispatches d WHERE d.organization_id=hs.id) AS dispatch_rows,
    (SELECT count(*) FROM public.warehouse_transfer_requests r WHERE r.source_organization_id=hs.id OR r.destination_organization_id=hs.id) AS transfer_request_rows,
    (SELECT count(*) FROM public.warehouse_transfers t WHERE t.source_organization_id=hs.id OR t.destination_organization_id=hs.id) AS transfer_rows,
    (SELECT count(*) FROM public.warehouse_supply_routes r
       JOIN public.warehouses sw ON sw.id=r.source_warehouse_id
       JOIN public.warehouses tw ON tw.id=r.target_warehouse_id
      WHERE sw.organization_id=hs.id OR tw.organization_id=hs.id) AS supply_route_rows,
    (SELECT count(*) FROM public.outlet_replenishment_routes r WHERE r.organization_id=hs.id) AS replenishment_route_rows,
    (SELECT count(*) FROM public.outlet_return_requests r WHERE r.source_organization_id=hs.id OR r.destination_organization_id=hs.id) AS outlet_return_request_rows,
    (SELECT count(*) FROM public.outlet_return_shipments s WHERE s.source_organization_id=hs.id OR s.destination_organization_id=hs.id) AS outlet_return_shipment_rows,
    (SELECT count(*) FROM public.item_availability a WHERE a.organization_id=hs.id) AS availability_rows,
    (SELECT count(*) FROM public.item_availability_movements m WHERE m.organization_id=hs.id) AS availability_movement_rows,
    (SELECT count(*) FROM public.phoenix_movement_dispense_context c WHERE c.organization_id=hs.id) AS dispense_context_rows,
    (SELECT count(*) FROM public.inter_org_exchange_requests e WHERE e.source_organization_id=hs.id OR e.target_organization_id=hs.id) AS exchange_request_rows
  FROM health_sectors hs
), evidence AS (
  SELECT hs.id AS organization_id, hs.name, hs.name_ar, hs.code, hs.status,
         f.facility_count,f.active_facility_count,f.facilities,
         w.warehouse_count,w.active_warehouses,w.valid_sector_mains,
         w.active_facility_null,w.active_mains,w.active_central,
         w.active_center_depots,w.facility_bound_mains,w.facility_null_nonmains,
         w.invalid_facility_depots,w.warehouses,
         d.facilities_with_multiple_active_depots,
         x.outlet_count,x.active_outlets,x.sector_level_outlets,x.rescue_carts,
         x.invalid_outlet_types,x.invalid_crash_contexts,x.outlets,
         op.warehouse_stock_rows,op.outlet_stock_rows,op.warehouse_movement_rows,
         op.outlet_movement_rows,op.dispatch_rows,op.transfer_request_rows,
         op.transfer_rows,op.supply_route_rows,op.replenishment_route_rows,
         op.outlet_return_request_rows,op.outlet_return_shipment_rows,
         op.availability_rows,op.availability_movement_rows,
         op.dispense_context_rows,op.exchange_request_rows,
         (op.warehouse_stock_rows+op.outlet_stock_rows+op.warehouse_movement_rows+
          op.outlet_movement_rows+op.dispatch_rows+op.transfer_request_rows+
          op.transfer_rows+op.supply_route_rows+op.replenishment_route_rows+
          op.outlet_return_request_rows+op.outlet_return_shipment_rows+
          op.availability_rows+op.availability_movement_rows+op.dispense_context_rows+
          op.exchange_request_rows) AS operational_rows
  FROM health_sectors hs
  JOIN facility_evidence f ON f.organization_id=hs.id
  JOIN warehouse_evidence w ON w.organization_id=hs.id
  JOIN duplicate_depots d ON d.organization_id=hs.id
  JOIN outlet_evidence x ON x.organization_id=hs.id
  JOIN operational_evidence op ON op.organization_id=hs.id
)
SELECT CASE
  WHEN valid_sector_mains=1 AND active_facility_null=1 AND active_mains=1
       AND facility_bound_mains=0 AND facility_null_nonmains=0 AND active_central=0
       AND invalid_facility_depots=0 AND facilities_with_multiple_active_depots=0
       AND sector_level_outlets=0 AND rescue_carts=0 AND invalid_outlet_types=0
       AND invalid_crash_contexts=0
    THEN 'TARGET_READY'
  WHEN valid_sector_mains=0 AND active_facility_null=0 AND active_mains=1
       AND facility_bound_mains=1 AND active_center_depots>=1 AND active_central=0
       AND invalid_facility_depots=0 AND facilities_with_multiple_active_depots=0
       AND sector_level_outlets=0 AND rescue_carts=0 AND invalid_outlet_types=0
       AND invalid_crash_contexts=0 AND operational_rows=0
    THEN 'SAFE_LEGACY_RECONCILABLE'
  ELSE 'AMBIGUOUS_STOP'
END AS classification,
evidence.*
FROM evidence
ORDER BY evidence.organization_id;
