-- ============================================================================
-- INVENTORY-SUGGESTION-LINEAGE-COMMITMENTS-149
--
-- Phase 5B only:
--   * explicit suggestion -> draft-line lineage for all executable corridors;
--   * one derived commitment contract backed by live documents and custody;
--   * historical suggestion_key fingerprint with one OPEN cycle at a time;
--   * canonical inv_suggest locks before linked lifecycle writers;
--   * no stock movement at suggestion/Draft/review time;
--   * no report, ledger, custody, RLS-visibility, permission-key or RPC
--     signature expansion.
-- ============================================================================

BEGIN;

DO $preconditions$
BEGIN
  IF to_regclass('public.inventory_transfer_suggestions') IS NULL
     OR to_regprocedure('public.phoenix_create_transfer_draft_from_suggestion(uuid,text)') IS NULL
     OR to_regprocedure('public._phoenix_lock_inventory_resources(text[])') IS NULL THEN
    RAISE EXCEPTION 'ABORT 149: migration 148 prerequisites are missing';
  END IF;
END;
$preconditions$;

-- ============================================================================
-- 1. Versioned, explicit line lineage.
-- ============================================================================

ALTER TABLE public.inventory_transfer_suggestions
  ADD COLUMN draft_warehouse_transfer_request_line_id uuid,
  ADD COLUMN draft_warehouse_dispatch_line_id uuid,
  ADD COLUMN draft_outlet_return_request_line_id uuid,
  ADD COLUMN lineage_version smallint NOT NULL DEFAULT 0,
  ADD COLUMN lineage_state text NOT NULL DEFAULT 'legacy_unresolved',
  ADD COLUMN commitment_closed_at timestamptz,
  ADD COLUMN commitment_closed_reason text;

CREATE UNIQUE INDEX warehouse_transfer_request_lines_id_head_uniq
  ON public.warehouse_transfer_request_lines (id, transfer_request_id);
CREATE UNIQUE INDEX warehouse_dispatch_lines_id_head_uniq
  ON public.warehouse_dispatch_lines (id, dispatch_id);
CREATE UNIQUE INDEX outlet_return_request_lines_id_head_uniq
  ON public.outlet_return_request_lines (id, return_request_id);

ALTER TABLE public.inventory_transfer_suggestions
  ADD CONSTRAINT inventory_suggestion_transfer_line_head_fk
    FOREIGN KEY (draft_warehouse_transfer_request_line_id, draft_warehouse_transfer_request_id)
    REFERENCES public.warehouse_transfer_request_lines (id, transfer_request_id)
    ON DELETE SET NULL (draft_warehouse_transfer_request_line_id),
  ADD CONSTRAINT inventory_suggestion_dispatch_line_head_fk
    FOREIGN KEY (draft_warehouse_dispatch_line_id, draft_warehouse_dispatch_id)
    REFERENCES public.warehouse_dispatch_lines (id, dispatch_id)
    ON DELETE SET NULL (draft_warehouse_dispatch_line_id),
  ADD CONSTRAINT inventory_suggestion_return_line_head_fk
    FOREIGN KEY (draft_outlet_return_request_line_id, draft_outlet_return_request_id)
    REFERENCES public.outlet_return_request_lines (id, return_request_id)
    ON DELETE SET NULL (draft_outlet_return_request_line_id);

ALTER TABLE public.inventory_transfer_suggestions
  ADD CONSTRAINT inventory_suggestion_lineage_state_chk CHECK (
    (lineage_version = 0
      AND lineage_state IN ('legacy_unresolved', 'legacy_terminal')
      AND draft_warehouse_transfer_request_line_id IS NULL
      AND draft_warehouse_dispatch_line_id IS NULL
      AND draft_outlet_return_request_line_id IS NULL
      AND commitment_closed_at IS NULL
      AND commitment_closed_reason IS NULL)
    OR
    (lineage_version = 1
      AND lineage_state = 'linked'
      AND commitment_closed_at IS NULL
      AND commitment_closed_reason IS NULL
      AND CASE route_kind
        WHEN 'central_to_institution' THEN
          draft_warehouse_transfer_request_line_id IS NOT NULL
          AND draft_warehouse_dispatch_line_id IS NULL
          AND draft_outlet_return_request_line_id IS NULL
        WHEN 'warehouse_to_outlet' THEN
          draft_warehouse_dispatch_line_id IS NOT NULL
          AND draft_warehouse_transfer_request_line_id IS NULL
          AND draft_outlet_return_request_line_id IS NULL
        WHEN 'outlet_to_warehouse' THEN
          draft_outlet_return_request_line_id IS NOT NULL
          AND draft_warehouse_transfer_request_line_id IS NULL
          AND draft_warehouse_dispatch_line_id IS NULL
        ELSE false
      END)
    OR
    (lineage_version = 1
      AND lineage_state = 'line_deleted'
      AND draft_warehouse_transfer_request_line_id IS NULL
      AND draft_warehouse_dispatch_line_id IS NULL
      AND draft_outlet_return_request_line_id IS NULL
      AND commitment_closed_at IS NOT NULL
      AND commitment_closed_reason = 'line_deleted')
  );

-- Historical linkage is semantic, never cardinality-only. A head with one
-- unrelated line is not evidence. Missing source identity, conflicting
-- identity, or multiple plausible candidates remains legacy_unresolved.
WITH candidates AS (
  SELECT s.id AS suggestion_id, l.id AS line_id
  FROM public.inventory_transfer_suggestions s
  JOIN public.warehouse_transfer_request_lines l
    ON l.transfer_request_id = s.draft_warehouse_transfer_request_id
  JOIN public.warehouse_stock ws
    ON ws.id = s.source_stock_id
   AND ws.organization_id = s.source_organization_id
   AND ws.warehouse_id = s.source_scope_id
  WHERE s.status = 'accepted'
    AND s.route_kind = 'central_to_institution'
    AND lower(btrim(l.scientific_name)) = lower(btrim(s.scientific_name))
    AND lower(btrim(ws.scientific_name)) = lower(btrim(s.scientific_name))
    AND (s.national_code IS NULL
         OR ws.national_code IS NOT DISTINCT FROM s.national_code)
    AND l.central_item_id IS NOT DISTINCT FROM ws.central_item_id
    AND (ws.concentration IS NULL
         OR lower(btrim(l.concentration)) = lower(btrim(ws.concentration)))
    AND (ws.dosage_form IS NULL
         OR lower(btrim(l.dosage_form)) = lower(btrim(ws.dosage_form)))
    AND (ws.unit IS NULL
         OR lower(btrim(l.unit)) = lower(btrim(ws.unit)))
),
unique_lines AS (
  SELECT suggestion_id, (array_agg(line_id ORDER BY line_id))[1] AS line_id
  FROM candidates
  GROUP BY suggestion_id
  HAVING count(*) = 1
)
UPDATE public.inventory_transfer_suggestions s
SET draft_warehouse_transfer_request_line_id = u.line_id,
    lineage_version = 1,
    lineage_state = 'linked'
FROM unique_lines u
WHERE s.id = u.suggestion_id;

WITH candidates AS (
  SELECT s.id AS suggestion_id, l.id AS line_id
  FROM public.inventory_transfer_suggestions s
  JOIN public.phoenix_dispatch_line_requests r
    ON r.request_id = s.id
   AND r.dispatch_id = s.draft_warehouse_dispatch_id
   AND r.dispatch_line_id IS NOT NULL
  JOIN public.warehouse_dispatch_lines l
    ON l.id = r.dispatch_line_id
   AND l.dispatch_id = s.draft_warehouse_dispatch_id
  JOIN public.warehouse_stock ws
    ON ws.id = s.source_stock_id
   AND ws.organization_id = s.source_organization_id
   AND ws.warehouse_id = s.source_scope_id
  WHERE s.status = 'accepted'
    AND s.route_kind = 'warehouse_to_outlet'
    AND l.warehouse_stock_id = s.source_stock_id
    AND lower(btrim(l.scientific_name)) = lower(btrim(s.scientific_name))
    AND lower(btrim(ws.scientific_name)) = lower(btrim(s.scientific_name))
    AND l.national_code IS NOT DISTINCT FROM s.national_code
    AND ws.national_code IS NOT DISTINCT FROM s.national_code
    AND l.central_item_id IS NOT DISTINCT FROM ws.central_item_id
),
unique_lines AS (
  SELECT suggestion_id, (array_agg(line_id ORDER BY line_id))[1] AS line_id
  FROM candidates
  GROUP BY suggestion_id
  HAVING count(*) = 1
)
UPDATE public.inventory_transfer_suggestions s
SET draft_warehouse_dispatch_line_id = u.line_id,
    lineage_version = 1,
    lineage_state = 'linked'
FROM unique_lines u
WHERE s.id = u.suggestion_id;

WITH candidates AS (
  SELECT s.id AS suggestion_id, l.id AS line_id
  FROM public.inventory_transfer_suggestions s
  JOIN public.outlet_return_request_lines l
    ON l.return_request_id = s.draft_outlet_return_request_id
   AND l.original_dispatch_line_id = s.provenance_dispatch_line_id
   AND l.original_inbound_movement_id = s.provenance_inbound_movement_id
   AND l.source_outlet_stock_id = s.source_stock_id
  JOIN public.outlet_stock os
    ON os.id = s.source_stock_id
   AND os.organization_id = s.source_organization_id
   AND os.distribution_point_id = s.source_scope_id
  WHERE s.status = 'accepted'
    AND s.route_kind = 'outlet_to_warehouse'
    AND lower(btrim(l.scientific_name)) = lower(btrim(s.scientific_name))
    AND lower(btrim(os.scientific_name)) = lower(btrim(s.scientific_name))
    AND (s.national_code IS NULL
         OR l.national_code IS NOT DISTINCT FROM s.national_code)
    AND (s.national_code IS NULL
         OR os.national_code IS NOT DISTINCT FROM s.national_code)
),
unique_lines AS (
  SELECT suggestion_id, (array_agg(line_id ORDER BY line_id))[1] AS line_id
  FROM candidates
  GROUP BY suggestion_id
  HAVING count(*) = 1
)
UPDATE public.inventory_transfer_suggestions s
SET draft_outlet_return_request_line_id = u.line_id,
    lineage_version = 1,
    lineage_state = 'linked'
FROM unique_lines u
WHERE s.id = u.suggestion_id;

-- A legacy document is zero only when its header proves a safely terminal
-- pre-custody outcome. Fulfilled/sent documents are not classified terminal
-- here because they may still own in-transit custody.
UPDATE public.inventory_transfer_suggestions s
SET lineage_state = 'legacy_terminal'
WHERE s.status = 'accepted'
  AND s.lineage_version = 0
  AND (
    (s.route_kind = 'central_to_institution' AND EXISTS (
      SELECT 1 FROM public.warehouse_transfer_requests h
      WHERE h.id = s.draft_warehouse_transfer_request_id
        AND h.status IN ('cancelled', 'rejected')
    ))
    OR
    (s.route_kind = 'warehouse_to_outlet' AND EXISTS (
      SELECT 1 FROM public.warehouse_dispatches h
      WHERE h.id = s.draft_warehouse_dispatch_id
        AND h.status IN ('cancelled', 'accepted', 'rejected')
    ))
    OR
    (s.route_kind = 'outlet_to_warehouse' AND EXISTS (
      SELECT 1 FROM public.outlet_return_requests h
      WHERE h.id = s.draft_outlet_return_request_id
        AND h.status IN ('cancelled', 'rejected')
    ))
  );

COMMENT ON COLUMN public.inventory_transfer_suggestions.lineage_version IS
  '0=historical row without deterministic line lineage; 1=149 line-aware lifecycle.';
COMMENT ON COLUMN public.inventory_transfer_suggestions.lineage_state IS
  'legacy_unresolved is conservatively committed; legacy_terminal is proven zero; linked follows live line/custody; line_deleted is a closed linked cycle.';

-- ============================================================================
-- 2. One derived commitment contract. No balances are persisted.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_inventory_suggestion_commitments(
  p_suggestion_id uuid
)
RETURNS TABLE (
  source_commitment integer,
  target_commitment integer,
  batch_commitment integer,
  provenance_commitment integer,
  commitment_state text,
  truth_source text,
  is_active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_s public.inventory_transfer_suggestions%ROWTYPE;
  v_staleness integer;
  v_unsent integer := 0;
  v_transit integer := 0;
  v_header_status text;
  v_line_status text;
  v_requested integer;
  v_approved integer;
  v_fulfilled integer;
BEGIN
  SELECT * INTO v_s
  FROM public.inventory_transfer_suggestions
  WHERE id = p_suggestion_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_s.status = 'open' THEN
    SELECT COALESCE(p.staleness_minutes, 30) INTO v_staleness
    FROM (SELECT 1) seed
    LEFT JOIN public.inventory_suggestion_policy p
      ON p.organization_id = v_s.source_organization_id;

    IF v_s.last_validated_at IS NULL
       OR v_s.last_validated_at < now() - make_interval(mins => v_staleness) THEN
      RETURN QUERY SELECT 0, 0, 0, 0, 'open_stale', 'suggestion_stale', false;
    ELSE
      RETURN QUERY SELECT
        v_s.suggested_quantity,
        v_s.suggested_quantity,
        v_s.suggested_quantity,
        CASE WHEN v_s.route_kind = 'outlet_to_warehouse'
             THEN v_s.suggested_quantity ELSE 0 END,
        'open_fresh',
        'suggestion',
        true;
    END IF;
    RETURN;
  END IF;

  IF v_s.status <> 'accepted' THEN
    RETURN QUERY SELECT 0, 0, 0, 0, v_s.status, 'suggestion_terminal', false;
    RETURN;
  END IF;

  IF v_s.lineage_version = 0 THEN
    IF v_s.lineage_state = 'legacy_terminal' THEN
      RETURN QUERY SELECT 0, 0, 0, 0, 'legacy_terminal', 'document_terminal', false;
    ELSE
      RETURN QUERY SELECT
        v_s.suggested_quantity,
        v_s.suggested_quantity,
        v_s.suggested_quantity,
        CASE WHEN v_s.route_kind = 'outlet_to_warehouse'
             THEN v_s.suggested_quantity ELSE 0 END,
        'legacy_unresolved',
        'legacy_conservative',
        true;
    END IF;
    RETURN;
  END IF;

  IF v_s.lineage_state = 'line_deleted' THEN
    RETURN QUERY SELECT 0, 0, 0, 0, 'line_deleted', 'document_line_deleted', false;
    RETURN;
  END IF;

  IF v_s.route_kind = 'central_to_institution' THEN
    SELECT h.status, l.status, l.requested_quantity,
           l.approved_quantity, l.fulfilled_quantity
      INTO v_header_status, v_line_status, v_requested, v_approved, v_fulfilled
    FROM public.warehouse_transfer_request_lines l
    JOIN public.warehouse_transfer_requests h ON h.id = l.transfer_request_id
    WHERE l.id = v_s.draft_warehouse_transfer_request_line_id
      AND h.id = v_s.draft_warehouse_transfer_request_id;

    IF NOT FOUND THEN
      RETURN QUERY SELECT v_s.suggested_quantity, v_s.suggested_quantity,
        v_s.suggested_quantity, 0, 'lineage_missing',
        'lineage_missing_conservative', true;
      RETURN;
    END IF;

    IF v_header_status NOT IN ('cancelled', 'rejected')
       AND v_line_status NOT IN ('cancelled', 'rejected') THEN
      v_unsent := CASE
        WHEN v_line_status = 'pending' THEN v_requested
        WHEN v_line_status IN ('approved', 'partially_fulfilled')
          THEN GREATEST(COALESCE(v_approved, 0) - v_fulfilled, 0)
        ELSE 0
      END;
    END IF;

    SELECT COALESCE(sum(l.sent_quantity), 0)::integer INTO v_transit
    FROM public.warehouse_transfer_lines l
    WHERE l.transfer_request_line_id = v_s.draft_warehouse_transfer_request_line_id
      AND l.status = 'in_transit';

  ELSIF v_s.route_kind = 'warehouse_to_outlet' THEN
    SELECT h.status, l.status, l.sent_quantity
      INTO v_header_status, v_line_status, v_requested
    FROM public.warehouse_dispatch_lines l
    JOIN public.warehouse_dispatches h ON h.id = l.dispatch_id
    WHERE l.id = v_s.draft_warehouse_dispatch_line_id
      AND h.id = v_s.draft_warehouse_dispatch_id;

    IF NOT FOUND THEN
      RETURN QUERY SELECT v_s.suggested_quantity, v_s.suggested_quantity,
        v_s.suggested_quantity, 0, 'lineage_missing',
        'lineage_missing_conservative', true;
      RETURN;
    END IF;

    IF v_header_status = 'draft' AND v_line_status = 'pending' THEN
      v_unsent := v_requested;
    ELSIF v_header_status IN ('sent', 'partially_accepted')
          AND v_line_status = 'pending' THEN
      v_transit := v_requested;
    END IF;

  ELSIF v_s.route_kind = 'outlet_to_warehouse' THEN
    SELECT h.status, l.status, l.requested_quantity,
           l.approved_quantity, l.fulfilled_quantity
      INTO v_header_status, v_line_status, v_requested, v_approved, v_fulfilled
    FROM public.outlet_return_request_lines l
    JOIN public.outlet_return_requests h ON h.id = l.return_request_id
    WHERE l.id = v_s.draft_outlet_return_request_line_id
      AND h.id = v_s.draft_outlet_return_request_id;

    IF NOT FOUND THEN
      RETURN QUERY SELECT v_s.suggested_quantity, v_s.suggested_quantity,
        v_s.suggested_quantity, v_s.suggested_quantity, 'lineage_missing',
        'lineage_missing_conservative', true;
      RETURN;
    END IF;

    IF v_header_status NOT IN ('cancelled', 'rejected')
       AND v_line_status NOT IN ('cancelled', 'rejected') THEN
      v_unsent := CASE
        WHEN v_line_status = 'pending' THEN v_requested
        WHEN v_line_status IN ('approved', 'partially_fulfilled')
          THEN GREATEST(COALESCE(v_approved, 0) - v_fulfilled, 0)
        ELSE 0
      END;
    END IF;

    SELECT COALESCE(sum(l.sent_quantity), 0)::integer INTO v_transit
    FROM public.outlet_return_shipment_lines l
    WHERE l.return_request_line_id = v_s.draft_outlet_return_request_line_id
      AND l.status = 'in_transit';
  END IF;

  RETURN QUERY SELECT
    v_unsent,
    v_unsent + v_transit,
    v_unsent,
    CASE WHEN v_s.route_kind = 'outlet_to_warehouse' THEN v_unsent ELSE 0 END,
    CASE
      WHEN v_unsent > 0 AND v_transit > 0 THEN 'partially_sent'
      WHEN v_transit > 0 THEN 'in_transit'
      WHEN v_unsent > 0 THEN 'document_open'
      ELSE 'terminal'
    END,
    CASE
      WHEN v_unsent > 0 AND v_transit > 0 THEN 'draft_and_in_transit'
      WHEN v_transit > 0 THEN 'in_transit_custody'
      WHEN v_unsent > 0 THEN 'draft_line'
      ELSE 'stock_quarantine_or_exception'
    END,
    (v_unsent + v_transit) > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_inventory_suggestion_commitments(uuid)
  FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 3. Suggestion-cycle uniqueness. The key is a historical fingerprint; only
--    one OPEN cycle may exist at a time.
-- ============================================================================

UPDATE public.inventory_transfer_suggestions s
SET status = 'expired', updated_at = now()
WHERE s.status = 'open'
  AND (
    s.last_validated_at IS NULL
    OR s.last_validated_at < now() - make_interval(mins => COALESCE((
      SELECT p.staleness_minutes
      FROM public.inventory_suggestion_policy p
      WHERE p.organization_id = s.source_organization_id
    ), 30))
  );

DROP INDEX public.inventory_suggestions_key_uniq;
CREATE UNIQUE INDEX inventory_suggestions_open_key_uniq
  ON public.inventory_transfer_suggestions (suggestion_key)
  WHERE status = 'open';

-- ============================================================================
-- Remaining definitions are appended below:
--   4. commitment-aware guard/generators/bridge
--   5. lifecycle pre-lock wrappers and constrained fixes
--   6. self-check and ACL preservation
-- ============================================================================

-- ============================================================================
-- 4a. Conservation guard: every historical/raw SUM is replaced by the single
--     derived contract. NEW itself is added explicitly because a BEFORE trigger
--     cannot query the not-yet-visible row.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_inventory_suggestion_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_corridor_write     boolean;
  v_qty_write          boolean;
  v_conservation_write boolean;
  v_reopen             boolean;
  v_available          integer;
  v_committed          integer;
  v_committed_line     integer;
  v_returnable         integer;
BEGIN
  v_reopen := (TG_OP = 'UPDATE')
    AND NEW.status IN ('open', 'accepted')
    AND NEW.status IS DISTINCT FROM OLD.status;
  v_corridor_write := (TG_OP = 'INSERT') OR v_reopen OR (
       NEW.source_scope_kind IS DISTINCT FROM OLD.source_scope_kind
    OR NEW.source_scope_id IS DISTINCT FROM OLD.source_scope_id
    OR NEW.target_scope_kind IS DISTINCT FROM OLD.target_scope_kind
    OR NEW.target_scope_id IS DISTINCT FROM OLD.target_scope_id
    OR NEW.route_kind IS DISTINCT FROM OLD.route_kind
    OR NEW.source_organization_id IS DISTINCT FROM OLD.source_organization_id
    OR NEW.target_organization_id IS DISTINCT FROM OLD.target_organization_id
    OR NEW.source_stock_id IS DISTINCT FROM OLD.source_stock_id
    OR NEW.scientific_name IS DISTINCT FROM OLD.scientific_name
    OR NEW.national_code IS DISTINCT FROM OLD.national_code
    OR NEW.provenance_dispatch_line_id IS DISTINCT FROM OLD.provenance_dispatch_line_id
    OR NEW.provenance_inbound_movement_id IS DISTINCT FROM OLD.provenance_inbound_movement_id
  );
  v_qty_write := (TG_OP = 'INSERT')
    OR (NEW.suggested_quantity IS DISTINCT FROM OLD.suggested_quantity);
  v_conservation_write := v_corridor_write OR v_qty_write;

  IF public.phoenix_inventory_scope_org(NEW.source_scope_kind, NEW.source_scope_id)
     IS DISTINCT FROM NEW.source_organization_id THEN
    RAISE EXCEPTION 'guard_072_source_scope_not_in_source_organization';
  END IF;
  IF public.phoenix_inventory_scope_org(NEW.target_scope_kind, NEW.target_scope_id)
     IS DISTINCT FROM NEW.target_organization_id THEN
    RAISE EXCEPTION 'guard_072_target_scope_not_in_target_organization';
  END IF;

  IF v_corridor_write THEN
    IF NEW.route_kind = 'warehouse_to_outlet' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.distribution_points dp
        WHERE dp.id = NEW.target_scope_id
          AND dp.warehouse_id = NEW.source_scope_id
          AND dp.organization_id = NEW.source_organization_id
      ) THEN RAISE EXCEPTION 'guard_072_no_warehouse_outlet_pairing'; END IF;
    ELSIF NEW.route_kind = 'outlet_to_warehouse' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.distribution_points dp
        WHERE dp.id = NEW.source_scope_id
          AND dp.warehouse_id = NEW.target_scope_id
          AND dp.organization_id = NEW.source_organization_id
      ) THEN RAISE EXCEPTION 'guard_072_no_outlet_warehouse_pairing'; END IF;
    ELSIF NEW.route_kind = 'central_to_institution' THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.warehouses sw
        JOIN public.warehouses tw ON tw.id = NEW.target_scope_id
        WHERE sw.id = NEW.source_scope_id
          AND sw.warehouse_kind = 'central' AND sw.status = 'active'
          AND sw.organization_id = NEW.source_organization_id
          AND tw.warehouse_kind = 'institution' AND tw.status = 'active'
          AND tw.organization_id = NEW.target_organization_id
      ) THEN RAISE EXCEPTION 'guard_072_no_active_central_institution_pairing'; END IF;
    ELSE
      RAISE EXCEPTION 'guard_072_invalid_route_kind';
    END IF;
  END IF;

  IF v_conservation_write AND NEW.status IN ('open', 'accepted') THEN
    IF NEW.route_kind = 'outlet_to_warehouse' THEN
      PERFORM public._phoenix_lock_inventory_resources(ARRAY[
        'inv_provline:' || NEW.provenance_dispatch_line_id::text,
        'inv_stock:' || NEW.source_stock_id::text
      ]);
      SELECT COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity
        INTO v_returnable
      FROM public.warehouse_dispatch_lines wdl
      WHERE wdl.id = NEW.provenance_dispatch_line_id
        AND wdl.status IN ('accepted', 'accepted_with_difference')
      FOR SHARE;
      IF v_returnable IS NULL THEN
        RAISE EXCEPTION 'guard_072_exceeds_returnable_quantity';
      END IF;
    ELSE
      PERFORM public._phoenix_lock_inventory_resources(ARRAY[
        'inv_stock:' || NEW.source_stock_id::text
      ]);
    END IF;

    IF NEW.source_scope_kind = 'warehouse' THEN
      SELECT ws.available_quantity INTO v_available
      FROM public.warehouse_stock ws
      WHERE ws.id = NEW.source_stock_id
        AND ws.warehouse_id = NEW.source_scope_id
        AND ws.organization_id = NEW.source_organization_id
        AND lower(ws.scientific_name) = lower(NEW.scientific_name)
        AND (NEW.national_code IS NULL OR ws.national_code = NEW.national_code)
        AND (ws.expiry_date IS NULL OR ws.expiry_date >= current_date)
      FOR SHARE;
    ELSE
      SELECT os.available_quantity INTO v_available
      FROM public.outlet_stock os
      WHERE os.id = NEW.source_stock_id
        AND os.distribution_point_id = NEW.source_scope_id
        AND os.organization_id = NEW.source_organization_id
        AND lower(os.scientific_name) = lower(NEW.scientific_name)
        AND (NEW.national_code IS NULL OR os.national_code = NEW.national_code)
        AND (os.expiry_date IS NULL OR os.expiry_date >= current_date)
      FOR SHARE;
    END IF;
    IF v_available IS NULL THEN
      RAISE EXCEPTION 'guard_072_source_stock_row_mismatch';
    END IF;

    SELECT COALESCE(sum(c.batch_commitment), 0)::integer INTO v_committed
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
    WHERE s.source_stock_id = NEW.source_stock_id
      AND s.id <> NEW.id
      AND c.is_active;
    IF v_committed + NEW.suggested_quantity > v_available THEN
      RAISE EXCEPTION 'guard_072_batch_oversubscribed';
    END IF;

    IF NEW.route_kind = 'outlet_to_warehouse' THEN
      SELECT COALESCE(sum(c.provenance_commitment), 0)::integer
        INTO v_committed_line
      FROM public.inventory_transfer_suggestions s
      CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
      WHERE s.provenance_dispatch_line_id = NEW.provenance_dispatch_line_id
        AND s.id <> NEW.id
        AND c.is_active;
      IF v_committed_line + NEW.suggested_quantity > v_returnable THEN
        RAISE EXCEPTION 'guard_072_exceeds_returnable_quantity';
      END IF;
    END IF;
  END IF;

  IF NEW.exchange_request_id IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW.exchange_request_id IS DISTINCT FROM OLD.exchange_request_id
          OR v_corridor_write) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.inter_org_exchange_requests x
      WHERE x.id = NEW.exchange_request_id
        AND x.source_organization_id = NEW.source_organization_id
        AND x.target_organization_id = NEW.target_organization_id
        AND lower(x.scientific_name) = lower(NEW.scientific_name)
    ) THEN RAISE EXCEPTION 'guard_072_exchange_request_mismatch'; END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 4b. Intra-organization generator: same deterministic allocator and FEFO
-- ordering as 077, but every commitment read comes from the 149 contract.
CREATE OR REPLACE FUNCTION public.phoenix_suggest_inventory_transfers(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_is_super boolean;
  v_need     record;
  v_src      record;
  v_batch    record;
  v_take     integer;
  v_need_remaining integer;
  v_src_remaining  integer;
  v_upserted integer := 0;
  v_superseded integer := 0;
  v_rows     integer;
  v_key      text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  v_is_super := (public.phoenix_my_role() = 'super_admin');

  PERFORM pg_advisory_xact_lock(hashtextextended('inv_suggest:' || p_organization_id::text, 0));

  CREATE TEMP TABLE _scopes (scope_kind text, scope_id uuid, PRIMARY KEY (scope_kind, scope_id)) ON COMMIT DROP;
  INSERT INTO _scopes
    SELECT 'warehouse', w.id
    FROM public.warehouses w
    WHERE w.organization_id = p_organization_id
      AND (v_is_super OR public.phoenix_profile_has_scoped_permission(
             v_actor, 'inventory.suggest_transfers', p_organization_id, w.id, NULL))
    UNION ALL
    SELECT 'outlet', dp.id
    FROM public.distribution_points dp
    WHERE dp.organization_id = p_organization_id
      AND (v_is_super OR public.phoenix_profile_has_scoped_permission(
             v_actor, 'inventory.suggest_transfers', p_organization_id, NULL, dp.id));

  IF NOT EXISTS (SELECT 1 FROM _scopes) THEN
    RAISE EXCEPTION 'not_authorized_inventory_suggest';
  END IF;

  UPDATE public.inventory_transfer_suggestions s
  SET status = 'expired', updated_at = now()
  WHERE s.source_organization_id = p_organization_id
    AND s.target_organization_id = p_organization_id
    AND s.status = 'open'
    AND EXISTS (SELECT 1 FROM _scopes sc
                WHERE sc.scope_kind = s.source_scope_kind AND sc.scope_id = s.source_scope_id)
    AND EXISTS (SELECT 1 FROM _scopes sc
                WHERE sc.scope_kind = s.target_scope_kind AND sc.scope_id = s.target_scope_id)
    AND NOT EXISTS (
      SELECT 1
      FROM public.phoenix_inventory_suggestion_commitments(s.id) c
      WHERE c.commitment_state = 'open_fresh'
    );

  -- A fresh OPEN row is the current cycle and remains stable across
  -- regeneration. The allocator below subtracts its derived commitments and
  -- ON CONFLICT refreshes the same key only when it is selected again. Only a
  -- stale OPEN row is expired above, which frees the partial unique key for a
  -- genuinely new historical cycle.
  v_superseded := 0;

  CREATE TEMP TABLE _need ON COMMIT DROP AS
    SELECT a.id AS alert_id, a.scope_kind, a.scope_id,
           a.scientific_name, lower(a.scientific_name) AS sci_lower, a.national_code,
           GREATEST(COALESCE(a.threshold_reorder_point, 0) - COALESCE(a.observed_available, 0), 1) AS deficit,
           GREATEST(COALESCE(a.threshold_reorder_point, 0) - COALESCE(a.observed_available, 0), 1)
             - COALESCE((
                 SELECT sum(c.target_commitment)
                 FROM public.inventory_transfer_suggestions s
                 CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
                 WHERE s.target_scope_kind = a.scope_kind
                   AND s.target_scope_id = a.scope_id
                   AND s.target_organization_id = a.organization_id
                   AND lower(s.scientific_name) = lower(a.scientific_name)
                   AND s.national_code IS NOT DISTINCT FROM a.national_code
                   AND c.is_active
               ), 0) AS remaining,
           CASE a.severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END AS prio
    FROM public.inventory_alerts a
    WHERE a.organization_id = p_organization_id
      AND a.status IN ('open', 'acknowledged', 'in_progress')
      AND a.signal_type IN ('missing', 'low_stock')
      AND EXISTS (SELECT 1 FROM _scopes sc
                  WHERE sc.scope_kind = a.scope_kind AND sc.scope_id = a.scope_id);

  CREATE TEMP TABLE _src ON COMMIT DROP AS
    SELECT a.id AS alert_id, a.scope_kind, a.scope_id,
           a.scientific_name, lower(a.scientific_name) AS sci_lower, a.national_code,
           GREATEST(COALESCE(a.observed_available, 0) - COALESCE(a.threshold_target_max, 0), 0) AS headroom,
           GREATEST(COALESCE(a.observed_available, 0) - COALESCE(a.threshold_target_max, 0), 0)
             - COALESCE((
                 SELECT sum(c.source_commitment)
                 FROM public.inventory_transfer_suggestions s
                 CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
                 WHERE s.source_scope_kind = a.scope_kind
                   AND s.source_scope_id = a.scope_id
                   AND s.source_organization_id = a.organization_id
                   AND lower(s.scientific_name) = lower(a.scientific_name)
                   AND s.national_code IS NOT DISTINCT FROM a.national_code
                   AND c.is_active
               ), 0) AS remaining
    FROM public.inventory_alerts a
    WHERE a.organization_id = p_organization_id
      AND a.status IN ('open', 'acknowledged', 'in_progress')
      AND a.signal_type = 'surplus'
      AND EXISTS (SELECT 1 FROM _scopes sc
                  WHERE sc.scope_kind = a.scope_kind AND sc.scope_id = a.scope_id);

  CREATE TEMP TABLE _batch ON COMMIT DROP AS
    SELECT b.scope_kind, b.scope_id, b.sci_lower, b.national_code,
           b.stock_id, b.batch_number, b.expiry_date, b.available_quantity,
           b.dispatch_line_id, b.inbound_movement_id,
           b.transferable_quantity
             - COALESCE((
                 SELECT sum(CASE
                   WHEN b.dispatch_line_id IS NULL THEN c.batch_commitment
                   ELSE c.provenance_commitment
                 END)
                 FROM public.inventory_transfer_suggestions s
                 CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
                 WHERE s.source_stock_id = b.stock_id
                   AND s.provenance_dispatch_line_id IS NOT DISTINCT FROM b.dispatch_line_id
                   AND c.is_active
               ), 0) AS remaining
    FROM (
      SELECT 'warehouse'::text AS scope_kind, ws.warehouse_id AS scope_id,
             lower(ws.scientific_name) AS sci_lower, ws.national_code,
             ws.id AS stock_id, ws.batch_number, ws.expiry_date,
             ws.available_quantity, ws.available_quantity AS transferable_quantity,
             NULL::uuid AS dispatch_line_id, NULL::uuid AS inbound_movement_id
      FROM public.warehouse_stock ws
      WHERE ws.organization_id = p_organization_id
        AND ws.available_quantity > 0
        AND (ws.expiry_date IS NULL OR ws.expiry_date >= current_date)
        AND EXISTS (SELECT 1 FROM _scopes sc
                    WHERE sc.scope_kind = 'warehouse' AND sc.scope_id = ws.warehouse_id)
      UNION ALL
      SELECT 'outlet', os.distribution_point_id,
             lower(os.scientific_name), os.national_code,
             os.id, os.batch_number, os.expiry_date,
             os.available_quantity,
             LEAST(os.available_quantity,
                   COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity),
             wdl.id, osm.id
      FROM public.outlet_stock os
      JOIN public.warehouse_dispatch_lines wdl
        ON wdl.resulting_outlet_stock_id = os.id
       AND wdl.organization_id = os.organization_id
       AND wdl.status IN ('accepted', 'accepted_with_difference')
      JOIN public.outlet_stock_movements osm
        ON osm.dispatch_line_id = wdl.id
       AND osm.movement_type = 'dispatch_receive'
       AND osm.outlet_stock_id = os.id
       AND osm.organization_id = os.organization_id
      WHERE os.organization_id = p_organization_id
        AND os.available_quantity > 0
        AND (os.expiry_date IS NULL OR os.expiry_date >= current_date)
        AND (COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity) > 0
        AND EXISTS (SELECT 1 FROM _scopes sc
                    WHERE sc.scope_kind = 'outlet' AND sc.scope_id = os.distribution_point_id)
    ) b;

  CREATE TEMP TABLE _stock_cap ON COMMIT DROP AS
    SELECT b.stock_id,
           MAX(b.available_quantity)
             - COALESCE((
                 SELECT sum(c.batch_commitment)
                 FROM public.inventory_transfer_suggestions s
                 CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
                 WHERE s.source_stock_id = b.stock_id
                   AND c.is_active
               ), 0) AS remaining
    FROM _batch b
    GROUP BY b.stock_id;

  FOR v_need IN
    SELECT * FROM _need WHERE remaining > 0
    ORDER BY prio DESC, sci_lower, scope_id, alert_id
  LOOP
    v_need_remaining := v_need.remaining;

    FOR v_src IN
      SELECT s.*,
             CASE
               WHEN s.scope_kind = 'warehouse' AND v_need.scope_kind = 'outlet'
                    AND EXISTS (SELECT 1 FROM public.distribution_points dp
                                 WHERE dp.id = v_need.scope_id AND dp.warehouse_id = s.scope_id
                                   AND dp.organization_id = p_organization_id)
                 THEN 'warehouse_to_outlet'
               WHEN s.scope_kind = 'outlet' AND v_need.scope_kind = 'warehouse'
                    AND EXISTS (SELECT 1 FROM public.distribution_points dp
                                 WHERE dp.id = s.scope_id AND dp.warehouse_id = v_need.scope_id
                                   AND dp.organization_id = p_organization_id)
                 THEN 'outlet_to_warehouse'
               WHEN s.scope_kind = 'warehouse' AND v_need.scope_kind = 'warehouse'
                    AND EXISTS (SELECT 1 FROM public.warehouses sw
                                 WHERE sw.id = s.scope_id
                                   AND sw.warehouse_kind = 'central' AND sw.status = 'active')
                    AND EXISTS (SELECT 1 FROM public.warehouses tw
                                 WHERE tw.id = v_need.scope_id
                                   AND tw.warehouse_kind = 'institution' AND tw.status = 'active')
                 THEN 'central_to_institution'
               ELSE NULL
             END AS route_kind
      FROM _src s
      WHERE s.remaining > 0
        AND s.sci_lower = v_need.sci_lower
        AND s.national_code IS NOT DISTINCT FROM v_need.national_code
        AND NOT (s.scope_kind = v_need.scope_kind AND s.scope_id = v_need.scope_id)
      ORDER BY s.remaining DESC, s.scope_id, s.alert_id
    LOOP
      EXIT WHEN v_need_remaining <= 0;
      CONTINUE WHEN v_src.route_kind IS NULL;

      SELECT remaining INTO v_src_remaining FROM _src WHERE alert_id = v_src.alert_id;
      CONTINUE WHEN v_src_remaining <= 0;

      FOR v_batch IN
        SELECT b.*, sc.remaining AS stock_remaining
        FROM _batch b
        JOIN _stock_cap sc ON sc.stock_id = b.stock_id
        WHERE b.scope_kind = v_src.scope_kind
          AND b.scope_id = v_src.scope_id
          AND b.sci_lower = v_src.sci_lower
          AND (v_src.national_code IS NULL OR b.national_code IS NOT DISTINCT FROM v_src.national_code)
          AND (v_src.national_code IS NOT NULL OR NOT EXISTS (
                 SELECT 1 FROM public.inventory_signal_thresholds tc
                 WHERE tc.organization_id = p_organization_id
                   AND tc.scope_kind = b.scope_kind
                   AND (tc.scope_id = b.scope_id OR tc.scope_id IS NULL)
                   AND tc.is_active
                   AND lower(tc.scientific_name) = b.sci_lower
                   AND tc.national_code IS NOT NULL
                   AND tc.national_code = b.national_code))
          AND b.remaining > 0
          AND sc.remaining > 0
        ORDER BY b.expiry_date ASC NULLS LAST, b.stock_id ASC,
                 COALESCE(b.dispatch_line_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC
      LOOP
        EXIT WHEN v_need_remaining <= 0 OR v_src_remaining <= 0;
        CONTINUE WHEN v_src.route_kind = 'outlet_to_warehouse' AND v_batch.dispatch_line_id IS NULL;

        v_take := LEAST(v_need_remaining, v_src_remaining, v_batch.remaining, v_batch.stock_remaining);
        CONTINUE WHEN v_take <= 0;

        v_key := p_organization_id::text
          || '|' || v_src.scope_kind  || '|' || v_src.scope_id::text
          || '|' || v_need.scope_kind || '|' || v_need.scope_id::text
          || '|' || v_need.sci_lower  || '|' || COALESCE(v_need.national_code, '')
          || '|' || v_batch.stock_id::text
          || '|' || COALESCE(v_batch.dispatch_line_id::text, '');

        INSERT INTO public.inventory_transfer_suggestions AS su (
          source_organization_id, target_organization_id, scientific_name, national_code,
          source_scope_kind, source_scope_id, target_scope_kind, target_scope_id, route_kind,
          source_stock_id, suggested_quantity, fefo_batch_number, fefo_expiry_date,
          source_batch_available_snapshot, source_surplus_snapshot, target_shortfall_snapshot,
          provenance_dispatch_line_id, provenance_inbound_movement_id,
          rationale, suggestion_key, status, first_suggested_at, last_suggested_at, last_validated_at
        )
        VALUES (
          p_organization_id, p_organization_id, v_need.scientific_name, v_need.national_code,
          v_src.scope_kind, v_src.scope_id, v_need.scope_kind, v_need.scope_id, v_src.route_kind,
          v_batch.stock_id, v_take, v_batch.batch_number, v_batch.expiry_date,
          v_batch.available_quantity, v_src.headroom, v_need.deficit,
          CASE WHEN v_src.route_kind = 'outlet_to_warehouse' THEN v_batch.dispatch_line_id ELSE NULL END,
          CASE WHEN v_src.route_kind = 'outlet_to_warehouse' THEN v_batch.inbound_movement_id ELSE NULL END,
          'deterministic allocation: one FEFO batch of a surplus source covers part of a shortage over a feasible corridor',
          v_key, 'open', now(), now(), now()
        )
        ON CONFLICT (suggestion_key) WHERE status = 'open' DO UPDATE SET
          suggested_quantity              = EXCLUDED.suggested_quantity,
          route_kind                      = EXCLUDED.route_kind,
          fefo_batch_number               = EXCLUDED.fefo_batch_number,
          fefo_expiry_date                = EXCLUDED.fefo_expiry_date,
          source_batch_available_snapshot = EXCLUDED.source_batch_available_snapshot,
          source_surplus_snapshot         = EXCLUDED.source_surplus_snapshot,
          target_shortfall_snapshot       = EXCLUDED.target_shortfall_snapshot,
          provenance_inbound_movement_id  = EXCLUDED.provenance_inbound_movement_id,
          last_suggested_at               = now(),
          last_validated_at               = now(),
          updated_at                      = now();

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        CONTINUE WHEN v_rows = 0;

        v_upserted := v_upserted + 1;
        v_need_remaining := v_need_remaining - v_take;
        v_src_remaining  := v_src_remaining - v_take;
        UPDATE _src SET remaining = remaining - v_take WHERE alert_id = v_src.alert_id;
        UPDATE _batch SET remaining = remaining - v_take
          WHERE stock_id = v_batch.stock_id
            AND dispatch_line_id IS NOT DISTINCT FROM v_batch.dispatch_line_id
            AND scope_kind = v_batch.scope_kind AND scope_id = v_batch.scope_id;
        UPDATE _stock_cap SET remaining = remaining - v_take WHERE stock_id = v_batch.stock_id;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'suggestions', v_upserted,
    'superseded', v_superseded
  );
END;
$$;

-- 4c. Cross-organization generator with the same contract and partial-key
-- cycle semantics.
CREATE OR REPLACE FUNCTION public.phoenix_suggest_cross_org_inventory_transfer(
  p_source_organization_id uuid,
  p_source_warehouse_id    uuid,
  p_target_organization_id uuid,
  p_target_warehouse_id    uuid,
  p_scientific_name        text,
  p_national_code          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name  text := NULLIF(btrim(p_scientific_name), '');
  v_code  text := NULLIF(btrim(p_national_code), '');
  v_lock_a text;
  v_lock_b text;
  v_surplus integer;
  v_shortfall integer;
  v_deficit_snapshot integer;
  v_headroom_snapshot integer;
  v_batch record;
  v_take integer;
  v_batch_remaining integer;
  v_minted integer := 0;
  v_rows integer;
  v_key text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF public.phoenix_my_role() <> 'super_admin' THEN
    RAISE EXCEPTION 'cross_org_suggestion_requires_super_admin';
  END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'scientific_name_required'; END IF;
  IF p_source_organization_id = p_target_organization_id THEN
    RAISE EXCEPTION 'use_intra_org_suggest_for_same_org';
  END IF;

  v_lock_a := LEAST(p_source_organization_id::text, p_target_organization_id::text);
  v_lock_b := GREATEST(p_source_organization_id::text, p_target_organization_id::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('inv_suggest:' || v_lock_a, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('inv_suggest:' || v_lock_b, 0));

  IF NOT EXISTS (
    SELECT 1
    FROM public.warehouses sw
    JOIN public.warehouses tw ON tw.id = p_target_warehouse_id
    WHERE sw.id = p_source_warehouse_id
      AND sw.warehouse_kind = 'central' AND sw.status = 'active'
      AND sw.organization_id = p_source_organization_id
      AND tw.warehouse_kind = 'institution' AND tw.status = 'active'
      AND tw.organization_id = p_target_organization_id
  ) THEN
    RAISE EXCEPTION 'no_active_central_institution_pairing';
  END IF;

  UPDATE public.inventory_transfer_suggestions s
  SET status = 'expired', updated_at = now()
  WHERE s.route_kind = 'central_to_institution'
    AND s.source_organization_id = p_source_organization_id
    AND s.target_organization_id = p_target_organization_id
    AND s.source_scope_kind = 'warehouse' AND s.source_scope_id = p_source_warehouse_id
    AND s.target_scope_kind = 'warehouse' AND s.target_scope_id = p_target_warehouse_id
    AND lower(s.scientific_name) = lower(v_name)
    AND s.national_code IS NOT DISTINCT FROM v_code
    AND s.status = 'open'
    AND NOT EXISTS (
      SELECT 1
      FROM public.phoenix_inventory_suggestion_commitments(s.id) c
      WHERE c.commitment_state = 'open_fresh'
    );

  -- Preserve a fresh OPEN cycle. Its live derived commitment is subtracted
  -- below; only stale rows are expired so the same fingerprint can start a new
  -- historical cycle.

  SELECT GREATEST(COALESCE(a.observed_available, 0) - COALESCE(a.threshold_target_max, 0), 0)
    INTO v_surplus
  FROM public.inventory_alerts a
  WHERE a.organization_id = p_source_organization_id
    AND a.scope_kind = 'warehouse' AND a.scope_id = p_source_warehouse_id
    AND a.signal_type = 'surplus'
    AND a.status IN ('open', 'acknowledged', 'in_progress')
    AND lower(a.scientific_name) = lower(v_name)
    AND a.national_code IS NOT DISTINCT FROM v_code
  ORDER BY a.last_observed_at DESC
  LIMIT 1;
  IF v_surplus IS NULL OR v_surplus <= 0 THEN
    RAISE EXCEPTION 'no_source_surplus';
  END IF;
  v_headroom_snapshot := v_surplus;

  SELECT GREATEST(COALESCE(a.threshold_reorder_point, 0) - COALESCE(a.observed_available, 0), 1)
    INTO v_shortfall
  FROM public.inventory_alerts a
  WHERE a.organization_id = p_target_organization_id
    AND a.scope_kind = 'warehouse' AND a.scope_id = p_target_warehouse_id
    AND a.signal_type IN ('missing', 'low_stock')
    AND a.status IN ('open', 'acknowledged', 'in_progress')
    AND lower(a.scientific_name) = lower(v_name)
    AND a.national_code IS NOT DISTINCT FROM v_code
  ORDER BY a.last_observed_at DESC
  LIMIT 1;
  IF v_shortfall IS NULL OR v_shortfall <= 0 THEN
    RAISE EXCEPTION 'no_target_shortfall';
  END IF;
  v_deficit_snapshot := v_shortfall;

  v_surplus := v_surplus - COALESCE((
    SELECT sum(c.source_commitment)
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
    WHERE s.source_scope_kind = 'warehouse'
      AND s.source_scope_id = p_source_warehouse_id
      AND s.source_organization_id = p_source_organization_id
      AND lower(s.scientific_name) = lower(v_name)
      AND s.national_code IS NOT DISTINCT FROM v_code
      AND c.is_active
  ), 0);
  IF v_surplus <= 0 THEN
    RAISE EXCEPTION 'source_surplus_already_committed';
  END IF;

  v_shortfall := v_shortfall - COALESCE((
    SELECT sum(c.target_commitment)
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
    WHERE s.target_scope_kind = 'warehouse'
      AND s.target_scope_id = p_target_warehouse_id
      AND s.target_organization_id = p_target_organization_id
      AND lower(s.scientific_name) = lower(v_name)
      AND s.national_code IS NOT DISTINCT FROM v_code
      AND c.is_active
  ), 0);
  IF v_shortfall <= 0 THEN
    RAISE EXCEPTION 'target_shortfall_already_covered';
  END IF;

  FOR v_batch IN
    SELECT ws.id AS stock_id, ws.batch_number, ws.expiry_date, ws.available_quantity
    FROM public.warehouse_stock ws
    WHERE ws.organization_id = p_source_organization_id
      AND ws.warehouse_id = p_source_warehouse_id
      AND lower(ws.scientific_name) = lower(v_name)
      AND (v_code IS NULL OR ws.national_code IS NOT DISTINCT FROM v_code)
      AND (v_code IS NOT NULL OR NOT EXISTS (
             SELECT 1 FROM public.inventory_signal_thresholds tc
             WHERE tc.organization_id = p_source_organization_id
               AND tc.scope_kind = 'warehouse'
               AND (tc.scope_id = p_source_warehouse_id OR tc.scope_id IS NULL)
               AND tc.is_active
               AND lower(tc.scientific_name) = lower(v_name)
               AND tc.national_code IS NOT NULL
               AND tc.national_code = ws.national_code))
      AND ws.available_quantity > 0
      AND (ws.expiry_date IS NULL OR ws.expiry_date >= current_date)
    ORDER BY ws.expiry_date ASC NULLS LAST, ws.id ASC
  LOOP
    EXIT WHEN v_surplus <= 0 OR v_shortfall <= 0;

    v_batch_remaining := v_batch.available_quantity - COALESCE((
      SELECT sum(c.batch_commitment)
      FROM public.inventory_transfer_suggestions s
      CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
      WHERE s.source_stock_id = v_batch.stock_id
        AND c.is_active
    ), 0);
    CONTINUE WHEN v_batch_remaining <= 0;

    v_take := LEAST(v_surplus, v_shortfall, v_batch_remaining);
    CONTINUE WHEN v_take <= 0;

    v_key := 'xorg|' || p_source_warehouse_id::text || '|' || p_target_warehouse_id::text
      || '|' || lower(v_name) || '|' || COALESCE(v_code, '')
      || '|' || v_batch.stock_id::text;

    INSERT INTO public.inventory_transfer_suggestions AS su (
      source_organization_id, target_organization_id, scientific_name, national_code,
      source_scope_kind, source_scope_id, target_scope_kind, target_scope_id, route_kind,
      source_stock_id, suggested_quantity, fefo_batch_number, fefo_expiry_date,
      source_batch_available_snapshot, source_surplus_snapshot, target_shortfall_snapshot,
      rationale, suggestion_key, status, first_suggested_at, last_suggested_at, last_validated_at
    )
    VALUES (
      p_source_organization_id, p_target_organization_id, v_name, v_code,
      'warehouse', p_source_warehouse_id, 'warehouse', p_target_warehouse_id, 'central_to_institution',
      v_batch.stock_id, v_take, v_batch.batch_number, v_batch.expiry_date,
      v_batch.available_quantity, v_headroom_snapshot, v_deficit_snapshot,
      'cross-org recommendation derived from live surplus, shortfall and one FEFO batch',
      v_key, 'open', now(), now(), now()
    )
    ON CONFLICT (suggestion_key) WHERE status = 'open' DO UPDATE SET
      suggested_quantity              = EXCLUDED.suggested_quantity,
      fefo_batch_number               = EXCLUDED.fefo_batch_number,
      fefo_expiry_date                = EXCLUDED.fefo_expiry_date,
      source_batch_available_snapshot = EXCLUDED.source_batch_available_snapshot,
      source_surplus_snapshot         = EXCLUDED.source_surplus_snapshot,
      target_shortfall_snapshot       = EXCLUDED.target_shortfall_snapshot,
      last_suggested_at               = now(),
      last_validated_at               = now(),
      updated_at                      = now();

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    CONTINUE WHEN v_rows = 0;
    v_minted := v_minted + 1;
    v_surplus := v_surplus - v_take;
    v_shortfall := v_shortfall - v_take;
  END LOOP;

  IF v_minted = 0 THEN
    RAISE EXCEPTION 'no_eligible_fefo_batch';
  END IF;

  RETURN jsonb_build_object(
    'route_kind', 'central_to_institution',
    'suggestions', v_minted
  );
END;
$$;

-- 4d. Draft bridge: preserves the signature and existing JSON fields, captures
-- the real line id, and uses only derived commitments for competing cycles.
CREATE OR REPLACE FUNCTION public.phoenix_create_transfer_draft_from_suggestion(
  p_suggestion_id uuid,
  p_document_number text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_doc text := NULLIF(btrim(p_document_number), '');
  v_s public.inventory_transfer_suggestions%ROWTYPE;
  v_initial_source_org uuid;
  v_initial_target_org uuid;
  v_policy_minutes integer;
  v_src_key text;
  v_tgt_key text;
  v_src_threshold_key text;
  v_tgt_threshold_key text;
  v_lock_a text;
  v_lock_b text;
  v_src_pos record;
  v_tgt_pos record;
  v_headroom integer;
  v_deficit integer;
  v_batch_available integer;
  v_batch_committed integer;
  v_batch_remaining integer;
  v_returnable integer;
  v_eligible integer;
  v_src_central_item_id uuid;
  v_src_concentration text;
  v_src_dosage_form text;
  v_src_unit text;
  v_src_scientific_name text;
  v_create_result jsonb;
  v_line_result jsonb;
  v_request_id uuid;
  v_request_line_id uuid;
  v_dispatch_id uuid;
  v_dispatch_line_id uuid;
  v_return_request_id uuid;
  v_return_request_line_id uuid;
  r record;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_doc IS NULL THEN RAISE EXCEPTION 'document_number_required'; END IF;

  SELECT * INTO v_s
  FROM public.inventory_transfer_suggestions
  WHERE id = p_suggestion_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found'; END IF;
  v_initial_source_org := v_s.source_organization_id;
  v_initial_target_org := v_s.target_organization_id;

  v_lock_a := LEAST(v_initial_source_org::text, v_initial_target_org::text);
  v_lock_b := GREATEST(v_initial_source_org::text, v_initial_target_org::text);
  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_suggest:' || v_lock_a,
    'inv_suggest:' || v_lock_b
  ]);

  SELECT * INTO v_s
  FROM public.inventory_transfer_suggestions
  WHERE id = p_suggestion_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found'; END IF;
  IF v_s.source_organization_id IS DISTINCT FROM v_initial_source_org
     OR v_s.target_organization_id IS DISTINCT FROM v_initial_target_org THEN
    RAISE EXCEPTION 'suggestion_changed_retry';
  END IF;

  IF v_s.status = 'accepted' THEN
    IF v_s.accepted_by = v_actor THEN
      IF v_s.lineage_state = 'line_deleted' THEN
        RAISE EXCEPTION 'suggestion_draft_line_deleted';
      END IF;
      RETURN jsonb_build_object(
        'ok', true, 'suggestion_id', v_s.id, 'idempotent_replay', true,
        'route_kind', v_s.route_kind, 'quantity', v_s.suggested_quantity,
        'document_number', v_s.draft_document_number,
        'warehouse_transfer_request_id', v_s.draft_warehouse_transfer_request_id,
        'warehouse_transfer_request_line_id', v_s.draft_warehouse_transfer_request_line_id,
        'warehouse_dispatch_id', v_s.draft_warehouse_dispatch_id,
        'warehouse_dispatch_line_id', v_s.draft_warehouse_dispatch_line_id,
        'outlet_return_request_id', v_s.draft_outlet_return_request_id,
        'outlet_return_request_line_id', v_s.draft_outlet_return_request_line_id
      );
    END IF;
    RAISE EXCEPTION 'suggestion_already_drafted';
  END IF;
  IF v_s.status <> 'open' THEN RAISE EXCEPTION 'suggestion_not_open'; END IF;

  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR (v_s.source_scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.source_organization_id, v_s.source_scope_id, NULL))
    OR (v_s.source_scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.source_organization_id, NULL, v_s.source_scope_id))
    OR (v_s.target_scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.target_organization_id, v_s.target_scope_id, NULL))
    OR (v_s.target_scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.target_organization_id, NULL, v_s.target_scope_id))
  ) THEN RAISE EXCEPTION 'not_authorized_inventory_act'; END IF;

  SELECT staleness_minutes INTO v_policy_minutes
  FROM public.inventory_suggestion_policy
  WHERE organization_id = v_s.source_organization_id;
  IF v_s.last_validated_at IS NULL
     OR v_s.last_validated_at < now() - make_interval(mins => COALESCE(v_policy_minutes, 30)) THEN
    UPDATE public.inventory_transfer_suggestions
    SET status = 'expired', updated_at = now()
    WHERE id = v_s.id;
    RAISE EXCEPTION 'suggestion_stale_revalidate_required';
  END IF;

  v_src_key := 'inv_position:' || v_s.source_organization_id::text || ':'
               || v_s.source_scope_kind || ':' || v_s.source_scope_id::text || ':'
               || lower(btrim(v_s.scientific_name)) || ':'
               || COALESCE(NULLIF(btrim(v_s.national_code), ''), '*');
  v_tgt_key := 'inv_position:' || v_s.target_organization_id::text || ':'
               || v_s.target_scope_kind || ':' || v_s.target_scope_id::text || ':'
               || lower(btrim(v_s.scientific_name)) || ':'
               || COALESCE(NULLIF(btrim(v_s.national_code), ''), '*');
  v_src_threshold_key := 'inv_threshold:' || v_s.source_organization_id::text || ':'
                         || v_s.source_scope_kind || ':' || lower(btrim(v_s.scientific_name));
  v_tgt_threshold_key := 'inv_threshold:' || v_s.target_organization_id::text || ':'
                         || v_s.target_scope_kind || ':' || lower(btrim(v_s.scientific_name));

  IF v_s.route_kind = 'outlet_to_warehouse' THEN
    PERFORM public._phoenix_lock_inventory_resources(ARRAY[
      'inv_provline:' || v_s.provenance_dispatch_line_id::text
    ]);
  END IF;
  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    v_src_key, v_tgt_key, v_src_threshold_key, v_tgt_threshold_key
  ]);

  IF v_s.route_kind = 'outlet_to_warehouse' THEN
    PERFORM 1
    FROM public.warehouse_dispatch_lines wdl
    WHERE wdl.id = v_s.provenance_dispatch_line_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'suggestion_no_longer_available: provenance_gone';
    END IF;
  END IF;

  FOR r IN
    SELECT *
    FROM (VALUES
      (v_s.source_scope_kind, v_s.source_scope_id, v_s.source_organization_id),
      (v_s.target_scope_kind, v_s.target_scope_id, v_s.target_organization_id)
    ) AS x(scope_kind, scope_id, organization_id)
    ORDER BY scope_kind, scope_id
  LOOP
    IF r.scope_kind = 'warehouse' THEN
      PERFORM 1 FROM public.warehouses w
      WHERE w.id = r.scope_id AND w.organization_id = r.organization_id
      FOR UPDATE;
    ELSE
      PERFORM 1 FROM public.distribution_points dp
      WHERE dp.id = r.scope_id AND dp.organization_id = r.organization_id
      FOR UPDATE;
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'scope_not_in_organization'; END IF;
  END LOOP;

  FOR r IN
    SELECT q.stock_kind, q.stock_id
    FROM (
      SELECT 'warehouse'::text AS stock_kind, ws.id AS stock_id
      FROM public.warehouse_stock ws
      WHERE lower(ws.scientific_name) = lower(btrim(v_s.scientific_name))
        AND (v_s.national_code IS NULL OR ws.national_code IS NOT DISTINCT FROM v_s.national_code)
        AND (
          (v_s.source_scope_kind = 'warehouse'
           AND ws.organization_id = v_s.source_organization_id
           AND ws.warehouse_id = v_s.source_scope_id)
          OR
          (v_s.target_scope_kind = 'warehouse'
           AND ws.organization_id = v_s.target_organization_id
           AND ws.warehouse_id = v_s.target_scope_id)
        )
      UNION ALL
      SELECT 'outlet'::text AS stock_kind, os.id AS stock_id
      FROM public.outlet_stock os
      WHERE lower(os.scientific_name) = lower(btrim(v_s.scientific_name))
        AND (v_s.national_code IS NULL OR os.national_code IS NOT DISTINCT FROM v_s.national_code)
        AND (
          (v_s.source_scope_kind = 'outlet'
           AND os.organization_id = v_s.source_organization_id
           AND os.distribution_point_id = v_s.source_scope_id)
          OR
          (v_s.target_scope_kind = 'outlet'
           AND os.organization_id = v_s.target_organization_id
           AND os.distribution_point_id = v_s.target_scope_id)
        )
    ) q
    ORDER BY q.stock_kind, q.stock_id
  LOOP
    IF r.stock_kind = 'warehouse' THEN
      PERFORM 1 FROM public.warehouse_stock ws WHERE ws.id = r.stock_id FOR UPDATE;
    ELSE
      PERFORM 1 FROM public.outlet_stock os WHERE os.id = r.stock_id FOR UPDATE;
    END IF;
  END LOOP;

  SELECT * INTO v_src_pos FROM public._phoenix_live_suggestion_scope_position(
    v_s.source_organization_id, v_s.source_scope_kind, v_s.source_scope_id,
    v_s.scientific_name, v_s.national_code);
  SELECT * INTO v_tgt_pos FROM public._phoenix_live_suggestion_scope_position(
    v_s.target_organization_id, v_s.target_scope_kind, v_s.target_scope_id,
    v_s.scientific_name, v_s.national_code);

  v_headroom := GREATEST(COALESCE(v_src_pos.live_available, 0) - COALESCE(v_src_pos.target_max, 0), 0);
  IF v_headroom <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: no_source_surplus';
  END IF;
  v_headroom := v_headroom - COALESCE((
    SELECT sum(c.source_commitment)
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
    WHERE s.source_scope_kind = v_s.source_scope_kind
      AND s.source_scope_id = v_s.source_scope_id
      AND s.source_organization_id = v_s.source_organization_id
      AND lower(s.scientific_name) = lower(v_s.scientific_name)
      AND s.national_code IS NOT DISTINCT FROM v_s.national_code
      AND s.id <> v_s.id
      AND c.is_active
  ), 0);
  IF v_headroom <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: source_surplus_committed';
  END IF;

  v_deficit := GREATEST(COALESCE(v_tgt_pos.reorder_point, 0) - COALESCE(v_tgt_pos.live_available, 0), 0);
  IF v_deficit <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: no_target_shortfall';
  END IF;
  v_deficit := v_deficit - COALESCE((
    SELECT sum(c.target_commitment)
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
    WHERE s.target_scope_kind = v_s.target_scope_kind
      AND s.target_scope_id = v_s.target_scope_id
      AND s.target_organization_id = v_s.target_organization_id
      AND lower(s.scientific_name) = lower(v_s.scientific_name)
      AND s.national_code IS NOT DISTINCT FROM v_s.national_code
      AND s.id <> v_s.id
      AND c.is_active
  ), 0);
  IF v_deficit <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: target_shortfall_committed';
  END IF;

  IF v_s.source_scope_kind = 'warehouse' THEN
    SELECT ws.available_quantity, ws.central_item_id, ws.concentration,
           ws.dosage_form, ws.unit, ws.scientific_name
      INTO v_batch_available, v_src_central_item_id, v_src_concentration,
           v_src_dosage_form, v_src_unit, v_src_scientific_name
    FROM public.warehouse_stock ws
    WHERE ws.id = v_s.source_stock_id
      AND ws.warehouse_id = v_s.source_scope_id
      AND ws.organization_id = v_s.source_organization_id
      AND lower(ws.scientific_name) = lower(v_s.scientific_name)
      AND (v_s.national_code IS NULL OR ws.national_code = v_s.national_code)
      AND (ws.expiry_date IS NULL OR ws.expiry_date >= current_date)
    FOR UPDATE;
  ELSE
    SELECT os.available_quantity, os.central_item_id, os.concentration,
           os.dosage_form, os.unit, os.scientific_name
      INTO v_batch_available, v_src_central_item_id, v_src_concentration,
           v_src_dosage_form, v_src_unit, v_src_scientific_name
    FROM public.outlet_stock os
    WHERE os.id = v_s.source_stock_id
      AND os.distribution_point_id = v_s.source_scope_id
      AND os.organization_id = v_s.source_organization_id
      AND lower(os.scientific_name) = lower(v_s.scientific_name)
      AND (v_s.national_code IS NULL OR os.national_code = v_s.national_code)
      AND (os.expiry_date IS NULL OR os.expiry_date >= current_date)
    FOR UPDATE;
  END IF;
  IF v_batch_available IS NULL THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: batch_gone_or_identity_mismatch';
  END IF;

  SELECT COALESCE(sum(c.batch_commitment), 0)::integer
    INTO v_batch_committed
  FROM public.inventory_transfer_suggestions s
  CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
  WHERE s.source_stock_id = v_s.source_stock_id
    AND s.id <> v_s.id
    AND c.is_active;
  v_batch_remaining := v_batch_available - v_batch_committed;

  IF v_s.route_kind = 'outlet_to_warehouse' THEN
    SELECT COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity
      INTO v_returnable
    FROM public.warehouse_dispatch_lines wdl
    WHERE wdl.id = v_s.provenance_dispatch_line_id
      AND wdl.status IN ('accepted', 'accepted_with_difference')
    FOR SHARE;
    IF v_returnable IS NULL THEN
      RAISE EXCEPTION 'suggestion_no_longer_available: provenance_gone';
    END IF;
    v_batch_remaining := LEAST(v_batch_remaining, v_returnable - COALESCE((
      SELECT sum(c.provenance_commitment)
      FROM public.inventory_transfer_suggestions s
      CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
      WHERE s.provenance_dispatch_line_id = v_s.provenance_dispatch_line_id
        AND s.id <> v_s.id
        AND c.is_active
    ), 0));
  END IF;

  v_eligible := LEAST(v_s.suggested_quantity, v_headroom, v_deficit, v_batch_remaining);
  IF v_eligible IS NULL OR v_eligible <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: eligible_quantity_zero';
  END IF;

  IF v_s.route_kind = 'central_to_institution' THEN
    v_create_result := public.phoenix_create_direct_warehouse_transfer_request(
      v_s.source_scope_id, v_s.target_organization_id, v_s.target_scope_id,
      v_doc, 'Auto-drafted from inventory suggestion ' || v_s.id::text);
    v_request_id := (v_create_result->>'transfer_request_id')::uuid;
    v_line_result := public.phoenix_add_warehouse_transfer_request_line(
      v_request_id, v_src_scientific_name, v_eligible, v_src_central_item_id,
      v_src_concentration, v_src_dosage_form, v_src_unit, NULL);
    v_request_line_id := (v_line_result->>'transfer_request_line_id')::uuid;

  ELSIF v_s.route_kind = 'warehouse_to_outlet' THEN
    v_create_result := public.phoenix_create_warehouse_dispatch(
      v_s.source_scope_id, v_s.target_scope_id, v_doc, NULL, NULL, NULL);
    v_dispatch_id := (v_create_result->>'dispatch_id')::uuid;
    v_line_result := public.phoenix_add_dispatch_line_fefo_guarded(
      v_dispatch_id, v_s.source_stock_id, v_eligible, false, NULL, p_suggestion_id);
    v_dispatch_line_id := (v_line_result->>'dispatch_line_id')::uuid;

  ELSIF v_s.route_kind = 'outlet_to_warehouse' THEN
    v_create_result := public.phoenix_request_outlet_return(
      v_s.source_scope_id, v_doc,
      'Auto-drafted from inventory suggestion ' || v_s.id::text);
    v_return_request_id := (v_create_result->>'return_request_id')::uuid;
    v_line_result := public.phoenix_add_outlet_return_request_line(
      v_return_request_id, v_s.provenance_dispatch_line_id, v_eligible,
      'excess', 'Auto-drafted from inventory suggestion ' || v_s.id::text);
    v_return_request_line_id := (v_line_result->>'return_request_line_id')::uuid;
  ELSE
    RAISE EXCEPTION 'unsupported_route_kind: %', v_s.route_kind;
  END IF;

  IF (v_s.route_kind = 'central_to_institution' AND v_request_line_id IS NULL)
     OR (v_s.route_kind = 'warehouse_to_outlet' AND v_dispatch_line_id IS NULL)
     OR (v_s.route_kind = 'outlet_to_warehouse' AND v_return_request_line_id IS NULL) THEN
    RAISE EXCEPTION 'draft_line_id_missing';
  END IF;

  UPDATE public.inventory_transfer_suggestions
  SET status = 'accepted',
      accepted_at = now(),
      accepted_by = v_actor,
      draft_document_number = v_doc,
      draft_warehouse_transfer_request_id = v_request_id,
      draft_warehouse_transfer_request_line_id = v_request_line_id,
      draft_warehouse_dispatch_id = v_dispatch_id,
      draft_warehouse_dispatch_line_id = v_dispatch_line_id,
      draft_outlet_return_request_id = v_return_request_id,
      draft_outlet_return_request_line_id = v_return_request_line_id,
      lineage_version = 1,
      lineage_state = 'linked',
      suggested_quantity = v_eligible,
      updated_at = now()
  WHERE id = p_suggestion_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action,
    entity_type, entity_id, entity_label, payload
  )
  VALUES (
    v_s.target_organization_id, v_actor, public.phoenix_my_role(), 'update',
    'inventory_transfer_suggestion', p_suggestion_id,
    v_s.route_kind || ':' || v_s.scientific_name,
    jsonb_build_object(
      'lifecycle', 'draft_created',
      'document_number', v_doc,
      'quantity', v_eligible,
      'route_kind', v_s.route_kind,
      'warehouse_transfer_request_line_id', v_request_line_id,
      'warehouse_dispatch_line_id', v_dispatch_line_id,
      'outlet_return_request_line_id', v_return_request_line_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'suggestion_id', p_suggestion_id, 'status', 'accepted',
    'quantity', v_eligible, 'route_kind', v_s.route_kind,
    'document_number', v_doc,
    'warehouse_transfer_request_id', v_request_id,
    'warehouse_transfer_request_line_id', v_request_line_id,
    'warehouse_dispatch_id', v_dispatch_id,
    'warehouse_dispatch_line_id', v_dispatch_line_id,
    'outlet_return_request_id', v_return_request_id,
    'outlet_return_request_line_id', v_return_request_line_id
  );
END;
$$;

-- ============================================================================
-- 5. Linked lifecycle pre-lock capsule.
--
-- Discovery is deliberately optimistic and unlocked. The helper then takes
-- sorted inv_suggest locks, re-selects/locks suggestion rows in id order, and
-- only then lets the existing writer acquire its request/document/stock locks.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._phoenix_lock_linked_suggestions(
  p_resource_kind text,
  p_resource_id uuid,
  p_close_deleted_line boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids uuid[];
  v_keys text[];
  v_count integer := 0;
BEGIN
  SELECT array_agg(s.id ORDER BY s.id)
    INTO v_ids
  FROM public.inventory_transfer_suggestions s
  WHERE s.status = 'accepted'
    AND (
      (p_resource_kind = 'central_line' AND (
        s.draft_warehouse_transfer_request_line_id = p_resource_id
        OR s.draft_warehouse_transfer_request_id = (
          SELECT l.transfer_request_id
          FROM public.warehouse_transfer_request_lines l
          WHERE l.id = p_resource_id
        )
      ))
      OR (p_resource_kind = 'central_header'
          AND s.draft_warehouse_transfer_request_id = p_resource_id)
      OR (p_resource_kind = 'transfer_line' AND EXISTS (
        SELECT 1
        FROM public.warehouse_transfer_lines l
        WHERE l.id = p_resource_id
          AND l.transfer_request_line_id = s.draft_warehouse_transfer_request_line_id
      ))
      OR (p_resource_kind = 'transfer_batch' AND EXISTS (
        SELECT 1
        FROM public.warehouse_transfer_lines l
        WHERE l.transfer_id = p_resource_id
          AND l.transfer_request_line_id = s.draft_warehouse_transfer_request_line_id
      ))
      OR (p_resource_kind = 'dispatch_line' AND (
        s.draft_warehouse_dispatch_line_id = p_resource_id
        OR s.draft_warehouse_dispatch_id = (
          SELECT l.dispatch_id
          FROM public.warehouse_dispatch_lines l
          WHERE l.id = p_resource_id
        )
      ))
      OR (p_resource_kind = 'dispatch_header'
          AND s.draft_warehouse_dispatch_id = p_resource_id)
      OR (p_resource_kind = 'return_line' AND (
        s.draft_outlet_return_request_line_id = p_resource_id
        OR s.draft_outlet_return_request_id = (
          SELECT l.return_request_id
          FROM public.outlet_return_request_lines l
          WHERE l.id = p_resource_id
        )
      ))
      OR (p_resource_kind = 'return_header'
          AND s.draft_outlet_return_request_id = p_resource_id)
      OR (p_resource_kind = 'return_shipment_line' AND EXISTS (
        SELECT 1
        FROM public.outlet_return_shipment_lines l
        WHERE l.id = p_resource_id
          AND l.return_request_line_id = s.draft_outlet_return_request_line_id
      ))
      OR (p_resource_kind = 'return_shipment' AND EXISTS (
        SELECT 1
        FROM public.outlet_return_shipment_lines l
        WHERE l.shipment_id = p_resource_id
          AND l.return_request_line_id = s.draft_outlet_return_request_line_id
      ))
    );

  IF COALESCE(cardinality(v_ids), 0) = 0 THEN
    RETURN 0;
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_keys
  FROM (
    SELECT DISTINCT 'inv_suggest:' || org_id::text AS k
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL unnest(ARRAY[
      s.source_organization_id, s.target_organization_id
    ]) org_id
    WHERE s.id = ANY(v_ids)
  ) q;
  PERFORM public._phoenix_lock_inventory_resources(v_keys);

  PERFORM 1
  FROM public.inventory_transfer_suggestions s
  WHERE s.id = ANY(v_ids)
  ORDER BY s.id
  FOR UPDATE;

  IF p_close_deleted_line THEN
    UPDATE public.inventory_transfer_suggestions s
    SET draft_warehouse_transfer_request_line_id = CASE
          WHEN p_resource_kind = 'central_line' THEN NULL
          ELSE s.draft_warehouse_transfer_request_line_id END,
        draft_warehouse_dispatch_line_id = CASE
          WHEN p_resource_kind = 'dispatch_line' THEN NULL
          ELSE s.draft_warehouse_dispatch_line_id END,
        draft_outlet_return_request_line_id = CASE
          WHEN p_resource_kind = 'return_line' THEN NULL
          ELSE s.draft_outlet_return_request_line_id END,
        lineage_state = 'line_deleted',
        commitment_closed_at = now(),
        commitment_closed_reason = 'line_deleted',
        updated_at = now()
    WHERE s.id = ANY(v_ids)
      AND s.lineage_version = 1
      AND s.lineage_state = 'linked'
      AND (
        (p_resource_kind = 'central_line'
         AND s.draft_warehouse_transfer_request_line_id = p_resource_id)
        OR (p_resource_kind = 'dispatch_line'
            AND s.draft_warehouse_dispatch_line_id = p_resource_id)
        OR (p_resource_kind = 'return_line'
            AND s.draft_outlet_return_request_line_id = p_resource_id)
      );
    GET DIAGNOSTICS v_count = ROW_COUNT;

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role, action,
      entity_type, entity_id, entity_label, payload
    )
    SELECT s.target_organization_id, auth.uid(), public.phoenix_my_role(),
           'update', 'inventory_transfer_suggestion', s.id,
           s.route_kind || ':' || s.scientific_name,
           jsonb_build_object(
             'lifecycle', 'commitment_closed',
             'reason', 'line_deleted',
             'resource_kind', p_resource_kind,
             'resource_id', p_resource_id
           )
    FROM public.inventory_transfer_suggestions s
    WHERE s.id = ANY(v_ids)
      AND s.lineage_state = 'line_deleted'
      AND s.commitment_closed_reason = 'line_deleted';
  ELSE
    v_count := cardinality(v_ids);
  END IF;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_lock_linked_suggestions(text, uuid, boolean)
  FROM PUBLIC, anon, authenticated;

-- Existing implementations become private delegates. Their business rules,
-- signatures, fingerprints and row-lock order stay byte-for-byte unchanged.
ALTER FUNCTION public.phoenix_update_warehouse_transfer_request_line(uuid, integer, text)
  RENAME TO _phoenix_149_delegate_update_warehouse_transfer_request_line;
ALTER FUNCTION public.phoenix_delete_warehouse_transfer_request_line(uuid)
  RENAME TO _phoenix_149_delegate_delete_warehouse_transfer_request_line;
ALTER FUNCTION public.phoenix_cancel_warehouse_transfer_request(uuid, text)
  RENAME TO _phoenix_149_delegate_cancel_warehouse_transfer_request;
ALTER FUNCTION public.phoenix_review_warehouse_transfer_request(uuid, jsonb)
  RENAME TO _phoenix_149_delegate_review_warehouse_transfer_request;
ALTER FUNCTION public.phoenix_send_direct_warehouse_transfer_line(uuid, uuid, uuid, integer, text, uuid, text, text)
  RENAME TO _phoenix_149_delegate_send_direct_warehouse_transfer_line;
ALTER FUNCTION public.phoenix_receive_warehouse_transfer_line(uuid, uuid, integer, text, text)
  RENAME TO _phoenix_149_delegate_receive_warehouse_transfer_line;

ALTER FUNCTION public.phoenix_update_dispatch_line_quantity(uuid, integer)
  RENAME TO _phoenix_149_delegate_update_dispatch_line_quantity;
ALTER FUNCTION public.phoenix_delete_dispatch_line(uuid)
  RENAME TO _phoenix_149_delegate_delete_dispatch_line;
ALTER FUNCTION public.phoenix_cancel_warehouse_dispatch(uuid, text)
  RENAME TO _phoenix_149_delegate_cancel_warehouse_dispatch;
ALTER FUNCTION public.phoenix_send_warehouse_dispatch(uuid, uuid)
  RENAME TO _phoenix_149_delegate_send_warehouse_dispatch;
ALTER FUNCTION public.phoenix_receive_outlet_dispatch_line(uuid, uuid, integer, text, text, text)
  RENAME TO _phoenix_149_delegate_receive_outlet_dispatch_line;

ALTER FUNCTION public.phoenix_delete_outlet_return_request_line(uuid)
  RENAME TO _phoenix_149_delegate_delete_outlet_return_request_line;
ALTER FUNCTION public.phoenix_cancel_outlet_return_request(uuid, text)
  RENAME TO _phoenix_149_delegate_cancel_outlet_return_request;
ALTER FUNCTION public.phoenix_review_outlet_return_request(uuid, jsonb)
  RENAME TO _phoenix_149_delegate_review_outlet_return_request;
ALTER FUNCTION public.phoenix_send_outlet_return_shipment_line(uuid, uuid, uuid, integer, text, text, text)
  RENAME TO _phoenix_149_delegate_send_outlet_return_shipment_line;
ALTER FUNCTION public.phoenix_receive_outlet_return_shipment_line(uuid, uuid, integer, text, text, text)
  RENAME TO _phoenix_149_delegate_receive_outlet_return_shipment_line;

ALTER FUNCTION public.phoenix_receive_all_matching_transfer_lines(uuid, uuid, jsonb, text)
  RENAME TO _phoenix_149_delegate_receive_all_matching_transfer_lines;
ALTER FUNCTION public.phoenix_receive_all_matching_dispatch_lines(uuid, uuid, jsonb, text)
  RENAME TO _phoenix_149_delegate_receive_all_matching_dispatch_lines;
ALTER FUNCTION public.phoenix_receive_all_matching_outlet_return_lines(uuid, uuid, jsonb, text)
  RENAME TO _phoenix_149_delegate_receive_all_matching_outlet_return_lines;

-- Central-to-institution wrappers.
CREATE FUNCTION public.phoenix_update_warehouse_transfer_request_line(
  p_transfer_request_line_id uuid,
  p_requested_quantity integer,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_linked_count integer;
  v_current_quantity integer;
BEGIN
  v_linked_count := public._phoenix_lock_linked_suggestions(
    'central_line', p_transfer_request_line_id, false);
  IF v_linked_count > 0 AND EXISTS (
    SELECT 1
    FROM public.inventory_transfer_suggestions s
    WHERE s.status = 'accepted'
      AND s.lineage_version = 1
      AND s.lineage_state = 'linked'
      AND s.draft_warehouse_transfer_request_line_id = p_transfer_request_line_id
  ) THEN
    SELECT requested_quantity
      INTO v_current_quantity
    FROM public.warehouse_transfer_request_lines
    WHERE id = p_transfer_request_line_id;
    IF p_requested_quantity > v_current_quantity THEN
      RAISE EXCEPTION 'suggestion_linked_quantity_increase_requires_regeneration'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN public._phoenix_149_delegate_update_warehouse_transfer_request_line(
    p_transfer_request_line_id, p_requested_quantity, p_notes);
END;
$$;

CREATE FUNCTION public.phoenix_delete_warehouse_transfer_request_line(
  p_transfer_request_line_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'central_line', p_transfer_request_line_id, true);
  RETURN public._phoenix_149_delegate_delete_warehouse_transfer_request_line(
    p_transfer_request_line_id);
END;
$$;

CREATE FUNCTION public.phoenix_cancel_warehouse_transfer_request(
  p_transfer_request_id uuid,
  p_cancellation_reason text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'central_header', p_transfer_request_id, false);
  RETURN public._phoenix_149_delegate_cancel_warehouse_transfer_request(
    p_transfer_request_id, p_cancellation_reason);
END;
$$;

CREATE FUNCTION public.phoenix_review_warehouse_transfer_request(
  p_transfer_request_id uuid,
  p_decisions jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'central_header', p_transfer_request_id, false);
  RETURN public._phoenix_149_delegate_review_warehouse_transfer_request(
    p_transfer_request_id, p_decisions);
END;
$$;

CREATE FUNCTION public.phoenix_send_direct_warehouse_transfer_line(
  p_request_id uuid,
  p_transfer_request_id uuid,
  p_warehouse_stock_id uuid,
  p_quantity integer,
  p_transfer_number text,
  p_transfer_request_line_id uuid DEFAULT NULL,
  p_document_number text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_expected_stock_id uuid;
BEGIN
  IF p_transfer_request_line_id IS NOT NULL THEN
    PERFORM public._phoenix_lock_linked_suggestions(
      'central_line', p_transfer_request_line_id, false);
    SELECT s.source_stock_id INTO v_expected_stock_id
    FROM public.inventory_transfer_suggestions s
    WHERE s.status = 'accepted'
      AND s.lineage_version = 1
      AND s.lineage_state = 'linked'
      AND s.draft_warehouse_transfer_request_line_id = p_transfer_request_line_id;
    IF FOUND AND v_expected_stock_id IS DISTINCT FROM p_warehouse_stock_id THEN
      RAISE EXCEPTION 'suggestion_source_stock_mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN public._phoenix_149_delegate_send_direct_warehouse_transfer_line(
    p_request_id, p_transfer_request_id, p_warehouse_stock_id, p_quantity,
    p_transfer_number, p_transfer_request_line_id, p_document_number, p_notes);
END;
$$;

CREATE FUNCTION public.phoenix_receive_warehouse_transfer_line(
  p_request_id uuid,
  p_transfer_line_id uuid,
  p_received_quantity integer,
  p_difference_reason text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'transfer_line', p_transfer_line_id, false);
  RETURN public._phoenix_149_delegate_receive_warehouse_transfer_line(
    p_request_id, p_transfer_line_id, p_received_quantity,
    p_difference_reason, p_notes);
END;
$$;

-- Warehouse-to-outlet wrappers.
CREATE FUNCTION public.phoenix_update_dispatch_line_quantity(
  p_dispatch_line_id uuid,
  p_quantity integer
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_linked_count integer;
  v_current_quantity integer;
BEGIN
  v_linked_count := public._phoenix_lock_linked_suggestions(
    'dispatch_line', p_dispatch_line_id, false);
  IF v_linked_count > 0 AND EXISTS (
    SELECT 1
    FROM public.inventory_transfer_suggestions s
    WHERE s.status = 'accepted'
      AND s.lineage_version = 1
      AND s.lineage_state = 'linked'
      AND s.draft_warehouse_dispatch_line_id = p_dispatch_line_id
  ) THEN
    SELECT sent_quantity
      INTO v_current_quantity
    FROM public.warehouse_dispatch_lines
    WHERE id = p_dispatch_line_id;
    IF p_quantity > v_current_quantity THEN
      RAISE EXCEPTION 'suggestion_linked_quantity_increase_requires_regeneration'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN public._phoenix_149_delegate_update_dispatch_line_quantity(
    p_dispatch_line_id, p_quantity);
END;
$$;

CREATE FUNCTION public.phoenix_delete_dispatch_line(p_dispatch_line_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'dispatch_line', p_dispatch_line_id, true);
  RETURN public._phoenix_149_delegate_delete_dispatch_line(p_dispatch_line_id);
END;
$$;

CREATE FUNCTION public.phoenix_cancel_warehouse_dispatch(
  p_dispatch_id uuid,
  p_cancellation_reason text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'dispatch_header', p_dispatch_id, false);
  RETURN public._phoenix_149_delegate_cancel_warehouse_dispatch(
    p_dispatch_id, p_cancellation_reason);
END;
$$;

CREATE FUNCTION public.phoenix_send_warehouse_dispatch(
  p_request_id uuid,
  p_dispatch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'dispatch_header', p_dispatch_id, false);
  RETURN public._phoenix_149_delegate_send_warehouse_dispatch(
    p_request_id, p_dispatch_id);
END;
$$;

CREATE FUNCTION public.phoenix_receive_outlet_dispatch_line(
  p_request_id uuid,
  p_dispatch_line_id uuid,
  p_received_quantity integer,
  p_difference_reason text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_reason_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'dispatch_line', p_dispatch_line_id, false);
  RETURN public._phoenix_149_delegate_receive_outlet_dispatch_line(
    p_request_id, p_dispatch_line_id, p_received_quantity,
    p_difference_reason, p_notes, p_reason_code);
END;
$$;

-- Outlet-to-warehouse wrappers and the two bounded header-status repairs.
CREATE FUNCTION public.phoenix_delete_outlet_return_request_line(
  p_return_request_line_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'return_line', p_return_request_line_id, true);
  RETURN public._phoenix_149_delegate_delete_outlet_return_request_line(
    p_return_request_line_id);
END;
$$;

CREATE FUNCTION public.phoenix_cancel_outlet_return_request(
  p_return_request_id uuid,
  p_cancellation_reason text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'return_header', p_return_request_id, false);
  RETURN public._phoenix_149_delegate_cancel_outlet_return_request(
    p_return_request_id, p_cancellation_reason);
END;
$$;

CREATE FUNCTION public.phoenix_review_outlet_return_request(
  p_return_request_id uuid,
  p_decisions jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'return_header', p_return_request_id, false);
  v_result := public._phoenix_149_delegate_review_outlet_return_request(
    p_return_request_id, p_decisions);

  IF NOT EXISTS (
    SELECT 1 FROM public.outlet_return_request_lines
    WHERE return_request_id = p_return_request_id AND status = 'pending'
  ) THEN
    UPDATE public.outlet_return_requests h
    SET status = CASE
      WHEN EXISTS (
        SELECT 1 FROM public.outlet_return_request_lines
        WHERE return_request_id = h.id AND status = 'approved'
      ) AND EXISTS (
        SELECT 1 FROM public.outlet_return_request_lines
        WHERE return_request_id = h.id AND status = 'rejected'
      ) THEN 'partially_approved'
      WHEN EXISTS (
        SELECT 1 FROM public.outlet_return_request_lines
        WHERE return_request_id = h.id AND status = 'approved'
      ) THEN 'approved'
      ELSE 'rejected'
    END
    WHERE h.id = p_return_request_id;
  END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.phoenix_send_outlet_return_shipment_line(
  p_request_id uuid,
  p_return_request_line_id uuid,
  p_shipment_id uuid,
  p_quantity integer,
  p_shipment_number text DEFAULT NULL,
  p_document_number text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_header_id uuid;
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'return_line', p_return_request_line_id, false);
  v_result := public._phoenix_149_delegate_send_outlet_return_shipment_line(
    p_request_id, p_return_request_line_id, p_shipment_id, p_quantity,
    p_shipment_number, p_document_number, p_notes);

  SELECT return_request_id INTO v_header_id
  FROM public.outlet_return_request_lines
  WHERE id = p_return_request_line_id;
  UPDATE public.outlet_return_requests h
  SET status = CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM public.outlet_return_request_lines l
      WHERE l.return_request_id = h.id
        AND l.status NOT IN ('fulfilled', 'rejected', 'cancelled')
    ) THEN 'fulfilled'
    ELSE 'partially_fulfilled'
  END
  WHERE h.id = v_header_id
    AND h.status IN ('approved', 'partially_approved', 'partially_fulfilled');
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.phoenix_receive_outlet_return_shipment_line(
  p_request_id uuid,
  p_shipment_line_id uuid,
  p_received_quantity integer,
  p_difference_reason text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_disposition_decision text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'return_shipment_line', p_shipment_line_id, false);
  RETURN public._phoenix_149_delegate_receive_outlet_return_shipment_line(
    p_request_id, p_shipment_line_id, p_received_quantity,
    p_difference_reason, p_notes, p_disposition_decision);
END;
$$;

-- Bulk entry points pre-lock every linked suggestion before their existing
-- bulk-request/header/line locks. Their nested receives then re-enter safely.
CREATE FUNCTION public.phoenix_receive_all_matching_transfer_lines(
  p_bulk_request_id uuid,
  p_transfer_id uuid,
  p_counted_lines jsonb,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'transfer_batch', p_transfer_id, false);
  RETURN public._phoenix_149_delegate_receive_all_matching_transfer_lines(
    p_bulk_request_id, p_transfer_id, p_counted_lines, p_notes);
END;
$$;

CREATE FUNCTION public.phoenix_receive_all_matching_dispatch_lines(
  p_bulk_request_id uuid,
  p_dispatch_id uuid,
  p_counted_lines jsonb,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'dispatch_header', p_dispatch_id, false);
  RETURN public._phoenix_149_delegate_receive_all_matching_dispatch_lines(
    p_bulk_request_id, p_dispatch_id, p_counted_lines, p_notes);
END;
$$;

CREATE FUNCTION public.phoenix_receive_all_matching_outlet_return_lines(
  p_bulk_request_id uuid,
  p_shipment_id uuid,
  p_counted_lines jsonb,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._phoenix_lock_linked_suggestions(
    'return_shipment', p_shipment_id, false);
  RETURN public._phoenix_149_delegate_receive_all_matching_outlet_return_lines(
    p_bulk_request_id, p_shipment_id, p_counted_lines, p_notes);
END;
$$;

-- Delegates are implementation details: callers retain only the historical
-- public signatures above.
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_update_warehouse_transfer_request_line(uuid, integer, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_delete_warehouse_transfer_request_line(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_cancel_warehouse_transfer_request(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_review_warehouse_transfer_request(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_send_direct_warehouse_transfer_line(uuid, uuid, uuid, integer, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_receive_warehouse_transfer_line(uuid, uuid, integer, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_update_dispatch_line_quantity(uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_delete_dispatch_line(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_cancel_warehouse_dispatch(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_send_warehouse_dispatch(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_receive_outlet_dispatch_line(uuid, uuid, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_delete_outlet_return_request_line(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_cancel_outlet_return_request(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_review_outlet_return_request(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_send_outlet_return_shipment_line(uuid, uuid, uuid, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_receive_outlet_return_shipment_line(uuid, uuid, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_receive_all_matching_transfer_lines(uuid, uuid, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_receive_all_matching_dispatch_lines(uuid, uuid, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_receive_all_matching_outlet_return_lines(uuid, uuid, jsonb, text)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.phoenix_update_warehouse_transfer_request_line(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_update_warehouse_transfer_request_line(uuid, integer, text) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_delete_warehouse_transfer_request_line(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_delete_warehouse_transfer_request_line(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_cancel_warehouse_transfer_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_cancel_warehouse_transfer_request(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_review_warehouse_transfer_request(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_review_warehouse_transfer_request(uuid, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_send_direct_warehouse_transfer_line(uuid, uuid, uuid, integer, text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_send_direct_warehouse_transfer_line(uuid, uuid, uuid, integer, text, uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_receive_warehouse_transfer_line(uuid, uuid, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_warehouse_transfer_line(uuid, uuid, integer, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_update_dispatch_line_quantity(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_update_dispatch_line_quantity(uuid, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_delete_dispatch_line(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_delete_dispatch_line(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_cancel_warehouse_dispatch(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_cancel_warehouse_dispatch(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_send_warehouse_dispatch(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_send_warehouse_dispatch(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_receive_outlet_dispatch_line(uuid, uuid, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_outlet_dispatch_line(uuid, uuid, integer, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_delete_outlet_return_request_line(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_delete_outlet_return_request_line(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_cancel_outlet_return_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_cancel_outlet_return_request(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_review_outlet_return_request(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_review_outlet_return_request(uuid, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_send_outlet_return_shipment_line(uuid, uuid, uuid, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_send_outlet_return_shipment_line(uuid, uuid, uuid, integer, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_receive_outlet_return_shipment_line(uuid, uuid, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_outlet_return_shipment_line(uuid, uuid, integer, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_receive_all_matching_transfer_lines(uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_all_matching_transfer_lines(uuid, uuid, jsonb, text) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_receive_all_matching_dispatch_lines(uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_all_matching_dispatch_lines(uuid, uuid, jsonb, text) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_receive_all_matching_outlet_return_lines(uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_all_matching_outlet_return_lines(uuid, uuid, jsonb, text) TO authenticated;

-- ============================================================================
-- 6. Fail-closed self-checks.
-- ============================================================================

DO $selfcheck$
DECLARE
  v_body text;
  v_name text;
BEGIN
  IF to_regclass('public.inventory_suggestions_key_uniq') IS NOT NULL
     OR to_regclass('public.inventory_suggestions_open_key_uniq') IS NULL THEN
    RAISE EXCEPTION 'ABORT 149: suggestion_key index contract is not partial-open';
  END IF;

  FOREACH v_name IN ARRAY ARRAY[
    'public.phoenix_suggest_inventory_transfers(uuid)',
    'public.phoenix_suggest_cross_org_inventory_transfer(uuid,uuid,uuid,uuid,text,text)',
    'public.phoenix_inventory_suggestion_guard()',
    'public.phoenix_create_transfer_draft_from_suggestion(uuid,text)'
  ] LOOP
    v_body := pg_get_functiondef(v_name::regprocedure);
    IF v_body ~* 'sum\s*\(\s*s\.suggested_quantity\s*\)' THEN
      RAISE EXCEPTION 'ABORT 149: raw commitment reader remains in %', v_name;
    END IF;
    IF v_body NOT LIKE '%phoenix_inventory_suggestion_commitments%' THEN
      RAISE EXCEPTION 'ABORT 149: derived commitment helper missing from %', v_name;
    END IF;
  END LOOP;

  IF has_function_privilege('authenticated',
       'public.phoenix_inventory_suggestion_commitments(uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.phoenix_inventory_suggestion_commitments(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public._phoenix_lock_linked_suggestions(text,uuid,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORT 149: an internal helper is directly executable';
  END IF;

  IF has_table_privilege('authenticated',
       'public.inventory_transfer_suggestions', 'INSERT')
     OR has_table_privilege('authenticated',
       'public.inventory_transfer_suggestions', 'UPDATE')
     OR has_table_privilege('authenticated',
       'public.inventory_transfer_suggestions', 'DELETE')
     OR has_table_privilege('anon',
       'public.inventory_transfer_suggestions', 'SELECT') THEN
    RAISE EXCEPTION 'ABORT 149: suggestion table ACL widened';
  END IF;

  v_body := pg_get_functiondef(
    'public.phoenix_create_transfer_draft_from_suggestion(uuid,text)'::regprocedure);
  IF v_body ~* '(insert\s+into|update)\s+public\.(warehouse_stock|outlet_stock|warehouse_quarantine_stock)'
     OR v_body ~* 'insert\s+into\s+public\.(warehouse_stock_movements|outlet_stock_movements|warehouse_quarantine_stock_movements)' THEN
    RAISE EXCEPTION 'ABORT 149: Draft bridge moves stock';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inventory_suggestion_transfer_line_head_fk'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inventory_suggestion_dispatch_line_head_fk'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inventory_suggestion_return_line_head_fk'
  ) THEN
    RAISE EXCEPTION 'ABORT 149: explicit line/header lineage is incomplete';
  END IF;
END;
$selfcheck$;

COMMIT;
