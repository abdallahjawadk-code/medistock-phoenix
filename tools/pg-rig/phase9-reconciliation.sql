/*
 * PHASE-9-RECONCILIATION
 *
 * Local/test-only, read-only anomaly detector. $1 is the organization UUID.
 * It never repairs, reserves, posts, or persists anything. An empty result is
 * healthy; every returned row needs human investigation against the canonical
 * ledgers and the referenced operational line.
 */
WITH canonical_movements AS (
  SELECT
    'warehouse'::text AS ledger_source,
    m.id,
    m.organization_id,
    m.reference_type,
    m.reference_id,
    m.causation_id,
    NULL::uuid AS dispatch_line_id,
    m.on_hand_before AS quantity_before,
    m.on_hand_delta AS quantity_delta,
    m.on_hand_after AS quantity_after
  FROM public.warehouse_stock_movements m
  WHERE m.organization_id = $1

  UNION ALL

  SELECT
    'outlet',
    m.id,
    m.organization_id,
    m.reference_type,
    m.reference_id,
    m.causation_id,
    m.dispatch_line_id,
    m.on_hand_before,
    m.on_hand_delta,
    m.on_hand_after
  FROM public.outlet_stock_movements m
  WHERE m.organization_id = $1

  UNION ALL

  SELECT
    'quarantine',
    m.id,
    m.organization_id,
    m.reference_type,
    m.reference_id,
    m.causation_id,
    NULL::uuid,
    m.quantity_before,
    m.quantity_delta,
    m.quantity_after
  FROM public.warehouse_quarantine_stock_movements m
  WHERE m.organization_id = $1
),
anomalies AS (
  SELECT
    'impossible_ledger_quantity'::text AS anomaly_kind,
    m.ledger_source AS corridor,
    m.id AS entity_id,
    jsonb_build_object(
      'reference_type', m.reference_type,
      'reference_id', m.reference_id,
      'before', m.quantity_before,
      'delta', m.quantity_delta,
      'after', m.quantity_after
    ) AS details
  FROM canonical_movements m
  WHERE m.quantity_after < 0
     OR m.quantity_before + m.quantity_delta <> m.quantity_after

  UNION ALL

  SELECT
    'duplicate_movement_reference',
    d.ledger_source,
    d.reference_id,
    jsonb_build_object(
      'reference_type', d.reference_type,
      'count', d.movement_count
    )
  FROM (
    SELECT
      m.ledger_source,
      m.reference_type,
      m.reference_id,
      count(*)::integer AS movement_count
    FROM canonical_movements m
    WHERE m.reference_id IS NOT NULL
      AND m.reference_type IN (
        'warehouse_transfer_send',
        'warehouse_transfer_receive',
        'warehouse_dispatch_send',
        'outlet_request',
        'outlet_return_send',
        'outlet_return_receive',
        'outlet_return_quarantine_receive'
      )
    GROUP BY m.ledger_source, m.reference_type, m.reference_id
    HAVING count(*) > 1
  ) d

  UNION ALL

  SELECT
    'movement_without_expected_custody',
    'central_to_institution',
    m.id,
    jsonb_build_object(
      'reference_type', m.reference_type,
      'reference_id', m.reference_id
    )
  FROM canonical_movements m
  WHERE m.ledger_source = 'warehouse'
    AND (
      (
        m.reference_type = 'warehouse_transfer_send'
        AND NOT EXISTS (
          SELECT 1
          FROM public.warehouse_transfer_lines l
          WHERE l.source_movement_id = m.id
        )
      )
      OR (
        m.reference_type = 'warehouse_transfer_receive'
        AND NOT EXISTS (
          SELECT 1
          FROM public.warehouse_transfer_lines l
          WHERE l.source_movement_id = m.causation_id
        )
      )
    )

  UNION ALL

  SELECT
    'movement_without_expected_custody',
    'warehouse_to_outlet',
    m.id,
    jsonb_build_object(
      'reference_type', m.reference_type,
      'reference_id', m.reference_id,
      'dispatch_line_id', m.dispatch_line_id
    )
  FROM canonical_movements m
  WHERE (
    m.ledger_source = 'warehouse'
    AND m.reference_type = 'warehouse_dispatch_send'
    AND NOT EXISTS (
      SELECT 1
      FROM public.warehouse_dispatch_lines l
      WHERE l.id = m.reference_id
    )
  ) OR (
    m.ledger_source = 'outlet'
    AND m.reference_type = 'outlet_request'
    AND NOT EXISTS (
      SELECT 1
      FROM public.warehouse_dispatch_lines l
      WHERE l.id = m.dispatch_line_id
        AND m.causation_id IS NOT NULL
    )
  )

  UNION ALL

  SELECT
    'movement_without_expected_custody',
    'outlet_to_warehouse',
    m.id,
    jsonb_build_object(
      'reference_type', m.reference_type,
      'reference_id', m.reference_id
    )
  FROM canonical_movements m
  WHERE (
    m.ledger_source = 'outlet'
    AND m.reference_type = 'outlet_return_send'
    AND NOT EXISTS (
      SELECT 1
      FROM public.outlet_return_shipment_lines l
      WHERE l.source_movement_id = m.id
    )
  ) OR (
    m.reference_type IN (
      'outlet_return_receive',
      'outlet_return_quarantine_receive'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.outlet_return_shipment_lines l
      WHERE l.source_movement_id = m.causation_id
    )
  )

  UNION ALL

  SELECT
    'custody_without_reference_movement',
    'central_to_institution',
    l.id,
    jsonb_build_object(
      'status', l.status,
      'source_movement_id', l.source_movement_id
    )
  FROM public.warehouse_transfer_lines l
  WHERE l.source_organization_id = $1
    AND (
      l.source_movement_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM public.warehouse_stock_movements m
        WHERE m.id = l.source_movement_id
          AND m.reference_type = 'warehouse_transfer_send'
      )
    )

  UNION ALL

  SELECT
    'custody_without_reference_movement',
    'warehouse_to_outlet',
    l.id,
    jsonb_build_object('status', l.status)
  FROM public.warehouse_dispatch_lines l
  JOIN public.warehouse_dispatches h ON h.id = l.dispatch_id
  WHERE l.organization_id = $1
    AND h.status <> 'draft'
    AND h.status <> 'cancelled'
    AND NOT EXISTS (
      SELECT 1
      FROM public.warehouse_stock_movements m
      WHERE m.reference_type = 'warehouse_dispatch_send'
        AND m.reference_id = l.id
    )

  UNION ALL

  SELECT
    'custody_without_reference_movement',
    'outlet_to_warehouse',
    l.id,
    jsonb_build_object(
      'status', l.status,
      'custody_state', l.custody_state,
      'source_movement_id', l.source_movement_id
    )
  FROM public.outlet_return_shipment_lines l
  WHERE l.source_organization_id = $1
    AND (
      l.source_movement_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM public.outlet_stock_movements m
        WHERE m.id = l.source_movement_id
          AND m.reference_type = 'outlet_return_send'
      )
    )

  UNION ALL

  SELECT
    'terminal_document_with_live_custody',
    'central_to_institution',
    h.id,
    jsonb_build_object(
      'header_status', h.status,
      'live_lines', count(l.id)
    )
  FROM public.warehouse_transfers h
  JOIN public.warehouse_transfer_lines l ON l.transfer_id = h.id
  WHERE (h.source_organization_id = $1 OR h.destination_organization_id = $1)
    AND h.status = 'received'
    AND l.status = 'in_transit'
  GROUP BY h.id, h.status

  UNION ALL

  SELECT
    'terminal_document_with_live_custody',
    'warehouse_to_outlet',
    h.id,
    jsonb_build_object(
      'header_status', h.status,
      'live_lines', count(l.id)
    )
  FROM public.warehouse_dispatches h
  JOIN public.warehouse_dispatch_lines l ON l.dispatch_id = h.id
  WHERE h.organization_id = $1
    AND h.status IN ('accepted', 'rejected')
    AND l.status = 'pending'
  GROUP BY h.id, h.status

  UNION ALL

  SELECT
    'terminal_document_with_live_custody',
    'outlet_to_warehouse',
    h.id,
    jsonb_build_object(
      'header_status', h.status,
      'live_lines', count(l.id)
    )
  FROM public.outlet_return_shipments h
  JOIN public.outlet_return_shipment_lines l ON l.shipment_id = h.id
  WHERE (h.source_organization_id = $1 OR h.destination_organization_id = $1)
    AND h.status = 'received'
    AND (l.status = 'in_transit' OR l.custody_state = 'in_transit')
  GROUP BY h.id, h.status

  UNION ALL

  SELECT
    'impossible_custody_quantity',
    'central_to_institution',
    l.id,
    jsonb_build_object(
      'sent', l.sent_quantity,
      'received', l.received_quantity
    )
  FROM public.warehouse_transfer_lines l
  WHERE l.source_organization_id = $1
    AND (
      l.sent_quantity <= 0
      OR l.received_quantity < 0
      OR l.received_quantity > l.sent_quantity
    )

  UNION ALL

  SELECT
    'impossible_custody_quantity',
    'warehouse_to_outlet',
    l.id,
    jsonb_build_object(
      'sent', l.sent_quantity,
      'received', l.received_quantity
    )
  FROM public.warehouse_dispatch_lines l
  WHERE l.organization_id = $1
    AND (
      l.sent_quantity <= 0
      OR l.received_quantity < 0
      OR l.received_quantity > l.sent_quantity
    )

  UNION ALL

  SELECT
    'impossible_custody_quantity',
    'outlet_to_warehouse',
    l.id,
    jsonb_build_object(
      'sent', l.sent_quantity,
      'received', l.received_quantity
    )
  FROM public.outlet_return_shipment_lines l
  WHERE l.source_organization_id = $1
    AND (
      l.sent_quantity <= 0
      OR l.received_quantity < 0
      OR l.received_quantity > l.sent_quantity
    )
)
SELECT anomaly_kind, corridor, entity_id, details
FROM anomalies
ORDER BY anomaly_kind, corridor, entity_id;
