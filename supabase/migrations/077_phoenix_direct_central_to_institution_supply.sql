-- ============================================================================
-- DIRECT-CENTRAL-TO-INSTITUTION-SUPPLY-077-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard -> SQL Editor after reading this file in full,
-- and ONLY after migrations 001-076 are confirmed applied and healthy.
--
-- VERIFICATION STATUS: pre-merge validation did NOT include execution against a
-- disposable PostgreSQL database. Validation is static analysis + CI + the
-- frontend contract tests in this PR. Section POST-CONDITIONS below is analysis,
-- not a proven runtime guarantee. Apply to a staging/preview database, run the
-- post-conditions, and confirm every one passes BEFORE production.
--
-- STRATEGY: EXPAND, additive, backward-compatible by construction.
--   * Modifies NONE of 001-076. Every change here is a new object, an additive
--     ALTER, or a CREATE OR REPLACE that PRESERVES the historical (route_id NOT
--     NULL) behavior byte-for-byte and only ADDS a route_id-IS-NULL branch.
--   * warehouse_supply_routes and its RPCs (066/075) are LEFT INTACT as legacy
--     compatibility. Nothing is dropped or REVOKEd here. Their removal is a
--     later CONTRACT migration, after the direct path is live, smoke-tested,
--     and no in-flight routed requests remain.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS COMPLETES
-- ─────────────────────────────────────────────────────────────────────────────
-- 068 modelled central->institution supply as ALWAYS travelling a pre-approved
-- warehouse_supply_route (route_id NOT NULL + composite FK). That forced a
-- manual "provisioning route" to exist before any stock could move.
--
-- 077 removes that requirement from the PRODUCT. A pharmacy-department (central)
-- warehouse officer now supplies an institution DIRECTLY: pick the institution,
-- pick its active warehouse (مذخر), supply. No route is created, named, or
-- consulted. Server-side validation replaces the route's structural guarantee.
--
--   direct request  = route_id NULL, source + destination pinned on the row
--   historical rows  = route_id present, unchanged, still FK-enforced
--
-- HOW route_id-NULL STAYS SAFE WITHOUT THE FK
--   The composite FKs wtr_route_endpoints_fk / wt_route_endpoints_fk are MATCH
--   SIMPLE (the default): when ANY referencing column is NULL the row is EXEMPT
--   from the constraint. Dropping NOT NULL on route_id therefore lets direct
--   rows through the SAME FK unchanged, while every historical routed row (all
--   three columns non-NULL) is still fully enforced. The endpoint integrity a
--   direct row loses from the route FK is re-established, per row, by:
--     * the still-enforced (warehouse_id, organization_id) composite FKs, and
--     * phoenix_assert_direct_supply_endpoints() called in every write path.
--   Source and destination are pinned at create and NEVER updated afterwards.
--
-- AUTHORITY (no permission keys added or granted — reuses 062/068's keys)
--   Direct supply is a central PUSH. For a direct (route_id NULL) request the
--   whole build/submit/cancel/send lifecycle is authorized against the SOURCE
--   (central) warehouse via warehouse_transfer.send; REVIEW keeps its existing
--   source-scoped warehouse_transfer.review; RECEIVE keeps its existing
--   destination-scoped warehouse_transfer.receive (068's RECEIVE is already
--   route-free and is NOT touched here). Historical routed requests keep their
--   original destination-scoped warehouse_transfer.request authority exactly.
--
-- INVENTORY INTELLIGENCE (072)
--   phoenix_suggest_inventory_transfers and phoenix_inventory_suggestion_guard
--   are CREATE OR REPLACE'd so the central_to_institution corridor is judged
--   feasible by "active central source + active institution target" rather than
--   by an active warehouse_supply_route. Candidates are still built ONLY from
--   real surplus/shortage alerts (O(alerts), never O(warehouses^2)); same
--   material/national_code identity; scope + organization checks intact;
--   recommendation-only. route_kind stays as a movement-type label (it was
--   never a FK to a route) so the table and the frontend are unchanged.
--
-- DIRECT RETURN (069) — institution -> central, route-free (section 7)
--   The reverse corridor is derived from PROVENANCE, never a route: a direct
--   return may only be opened between an active institution warehouse and an
--   active central warehouse that a real direct (route_id NULL) forward transfer
--   already connected, and every returned line must name an original transfer
--   line of THAT direct forward delivery. Endpoints are pinned on the return row
--   and never mutated. Caps (per-line approved / per-original returned), ledger
--   conservation, the fail-closed quarantine classification at receive,
--   idempotency by (reference_type, reference_id) + fingerprint, advisory-lock-
--   first / row-lock-second ordering, audit, and RLS/ACL are all reproduced from
--   069 unchanged. RECEIVE (069 §11) is already route-free and is reused as-is.
--
-- CROSS-ORG SUGGESTION (072 §11) — route-free (section 6c)
--   phoenix_suggest_cross_org_inventory_transfer is CREATE OR REPLACE'd so the
--   super_admin cross-ORG corridor is judged feasible by an active central
--   source + active institution target, each owned by its claimed organization,
--   NOT by a supply route. It remains recommendation-only (acceptance disabled;
--   operators act through the 041 exchange RPC path) and mints NO stock movement.
--
-- OUT OF SCOPE (later CONTRACT migration, not this PR):
--   * Physically RETIRING warehouse_supply_routes and its 066/075 RPCs. They are
--     LEFT INTACT here as legacy compatibility (historical routed rows stay
--     valid and fully FK-enforced); nothing new depends on them.
-- ============================================================================

begin;

-- ── PRECONDITIONS ────────────────────────────────────────────────────────────
DO $guard$
BEGIN
  IF to_regclass('public.warehouse_transfer_requests') IS NULL
     OR to_regclass('public.warehouse_transfers') IS NULL THEN
    RAISE EXCEPTION 'ABORT 077: 068 transfer tables absent — apply 068 first.';
  END IF;
  IF to_regclass('public.warehouse_return_requests') IS NULL
     OR to_regclass('public.warehouse_return_shipments') IS NULL THEN
    RAISE EXCEPTION 'ABORT 077: 069 return tables absent — apply 069 first.';
  END IF;
  IF to_regclass('public.warehouses') IS NULL OR to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'ABORT 077: warehouses/audit_logs absent — apply 060/001 first.';
  END IF;
  IF to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid, text, uuid, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 077: phoenix_profile_has_scoped_permission is absent — apply 062 first.';
  END IF;
  IF to_regprocedure('public.phoenix_suggest_inventory_transfers(uuid)') IS NULL
     OR to_regprocedure('public.phoenix_inventory_suggestion_guard()') IS NULL THEN
    RAISE EXCEPTION 'ABORT 077: 072 inventory intelligence absent — apply 072 first.';
  END IF;
  -- warehouse_kind (066) is the basis for every endpoint assertion below.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='warehouses'
                   AND column_name='warehouse_kind') THEN
    RAISE EXCEPTION 'ABORT 077: warehouses.warehouse_kind absent — apply 066 first.';
  END IF;
END;
$guard$;

-- ============================================================================
-- 1. ADDITIVE SCHEMA — route_id becomes optional (historical rows unchanged)
-- ============================================================================
-- DROP NOT NULL is additive and backward-compatible: existing non-NULL rows
-- remain valid and still FK-enforced; only new direct rows may use NULL. The
-- composite route FKs (MATCH SIMPLE) are intentionally LEFT IN PLACE.
ALTER TABLE public.warehouse_transfer_requests ALTER COLUMN route_id DROP NOT NULL;
ALTER TABLE public.warehouse_transfers         ALTER COLUMN route_id DROP NOT NULL;

-- NOTE: the two 069 RETURN tables' route_id is made NULLable in section 7 below,
-- immediately ABOVE the direct-return RPCs that are the ONLY writers of a
-- NULL-route return row. Nullability is never introduced ahead of a safe writer.

COMMENT ON COLUMN public.warehouse_transfer_requests.route_id IS
  'NULL for a 077 DIRECT central->institution request (endpoints pinned on the '
  'row, validated by phoenix_assert_direct_supply_endpoints). Non-NULL for a '
  'legacy 068 routed request (composite FK to warehouse_supply_routes enforced).';
COMMENT ON COLUMN public.warehouse_transfers.route_id IS
  'NULL for a 077 DIRECT transfer; non-NULL for a legacy 068 routed transfer.';

-- Direct rows are found by route_id IS NULL; a partial index keeps that cheap.
CREATE INDEX IF NOT EXISTS wtr_direct_idx
  ON public.warehouse_transfer_requests (destination_warehouse_id, status)
  WHERE route_id IS NULL;
CREATE INDEX IF NOT EXISTS wt_direct_idx
  ON public.warehouse_transfers (destination_warehouse_id, status)
  WHERE route_id IS NULL;

-- ============================================================================
-- 2. SHARED ENDPOINT VALIDATOR — the direct path's replacement for the route FK
-- ============================================================================
-- Fail-closed. Asserts, under the caller's transaction, that a (source ->
-- destination) pair is a legitimate central->institution corridor: source is an
-- ACTIVE central warehouse, destination is an ACTIVE institution warehouse in
-- the named organization, and the two differ. Returns the resolved source and
-- destination organization ids so callers do not re-query. FOR SHARE locks both
-- warehouse rows so a concurrent deactivation cannot slip past this check.
CREATE OR REPLACE FUNCTION public.phoenix_assert_direct_supply_endpoints(
  p_source_warehouse_id      uuid,
  p_destination_warehouse_id uuid,
  p_destination_organization_id uuid,
  OUT o_source_organization_id uuid,
  OUT o_destination_organization_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_src public.warehouses%ROWTYPE;
  v_dst public.warehouses%ROWTYPE;
BEGIN
  IF p_source_warehouse_id IS NULL OR p_destination_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'source_and_destination_required' USING ERRCODE = '23514';
  END IF;
  IF p_source_warehouse_id = p_destination_warehouse_id THEN
    RAISE EXCEPTION 'source_and_destination_must_differ' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_src FROM public.warehouses WHERE id = p_source_warehouse_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_warehouse_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_src.warehouse_kind <> 'central' OR v_src.status <> 'active' THEN
    RAISE EXCEPTION 'source_must_be_active_central_warehouse' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_dst FROM public.warehouses WHERE id = p_destination_warehouse_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_warehouse_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_dst.warehouse_kind <> 'institution' OR v_dst.status <> 'active' THEN
    RAISE EXCEPTION 'destination_must_be_active_institution_warehouse' USING ERRCODE = '23514';
  END IF;

  -- The destination warehouse must belong to the institution the caller named —
  -- closes the IDOR of pinning a warehouse to the wrong organization.
  IF p_destination_organization_id IS NOT NULL
     AND v_dst.organization_id IS DISTINCT FROM p_destination_organization_id THEN
    RAISE EXCEPTION 'destination_warehouse_not_in_named_organization' USING ERRCODE = '42501';
  END IF;

  o_source_organization_id      := v_src.organization_id;
  o_destination_organization_id := v_dst.organization_id;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_assert_direct_supply_endpoints(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_assert_direct_supply_endpoints(uuid, uuid, uuid) TO authenticated;

-- ============================================================================
-- 3. DIRECT CREATE — a central officer opens a direct request (route_id NULL)
-- ============================================================================
-- Mirrors phoenix_create_warehouse_transfer_request (068 §8a) but takes the two
-- endpoints DIRECTLY instead of a route, pins them on the row, and authorizes
-- against the SOURCE (central) warehouse. Creates NO backing supply route.
CREATE OR REPLACE FUNCTION public.phoenix_create_direct_warehouse_transfer_request(
  p_source_warehouse_id         uuid,
  p_destination_organization_id uuid,
  p_destination_warehouse_id    uuid,
  p_request_number              text,
  p_notes                       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_src_org     uuid;
  v_dest_org    uuid;
  v_number      text := NULLIF(btrim(p_request_number), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_request     public.warehouse_transfer_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_source_warehouse_id IS NULL OR p_destination_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'source_and_destination_required' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'request_number_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_destination_warehouse_id::text, 68069));

  SELECT o_source_organization_id, o_destination_organization_id
    INTO v_src_org, v_dest_org
  FROM public.phoenix_assert_direct_supply_endpoints(
         p_source_warehouse_id, p_destination_warehouse_id, p_destination_organization_id);

  -- THE IDOR GATE. Authority is the actor's scoped assignment to the SOURCE
  -- (central) warehouse — the central push is accountable for what it sends.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.send', v_src_org, p_source_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_direct_warehouse_transfer' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.warehouse_transfer_requests (
    route_id, source_warehouse_id, source_organization_id,
    destination_warehouse_id, destination_organization_id,
    request_number, status, notes, created_by
  ) VALUES (
    NULL, p_source_warehouse_id, v_src_org,
    p_destination_warehouse_id, v_dest_org,
    v_number, 'draft', v_notes, v_actor
  )
  RETURNING * INTO v_request;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_src_org, v_actor, v_actor_role,
    'warehouse_transfer.request_created', 'warehouse_transfer_requests', v_request.id, v_number,
    jsonb_build_object('direct', true, 'source_warehouse_id', p_source_warehouse_id,
                       'destination_warehouse_id', p_destination_warehouse_id)
  );

  RETURN jsonb_build_object('ok', true, 'transfer_request_id', v_request.id,
                            'status', v_request.status, 'direct', true);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_create_direct_warehouse_transfer_request(uuid, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_create_direct_warehouse_transfer_request(uuid, uuid, uuid, text, text) TO authenticated;

-- ============================================================================
-- 4. LIFECYCLE RE-DEFINITIONS — add a route_id-IS-NULL branch, keep legacy path
-- ============================================================================
-- Each function below is REPLACED with its 068 body preserved verbatim for the
-- route_id NOT NULL (legacy) case, and a source-scoped branch added for the
-- direct (route_id NULL) case. The direct branch authorizes against the SOURCE
-- warehouse (warehouse_transfer.send) and skips every route lookup.

-- 4a. ADD LINE
CREATE OR REPLACE FUNCTION public.phoenix_add_warehouse_transfer_request_line(
  p_transfer_request_id uuid,
  p_scientific_name     text,
  p_requested_quantity  integer,
  p_central_item_id     uuid DEFAULT NULL,
  p_concentration       text DEFAULT NULL,
  p_dosage_form         text DEFAULT NULL,
  p_unit                text DEFAULT NULL,
  p_notes               text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_request  public.warehouse_transfer_requests%ROWTYPE;
  v_name     text := NULLIF(btrim(p_scientific_name), '');
  v_line_id  uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_transfer_request_id IS NULL THEN
    RAISE EXCEPTION 'transfer_request_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'scientific_name_required' USING ERRCODE = '23514';
  END IF;
  IF p_requested_quantity IS NULL OR p_requested_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.warehouse_transfer_requests WHERE id = p_transfer_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._phoenix_authorize_transfer_request_write(v_actor, v_request);

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'transfer_request_not_draft' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.warehouse_transfer_request_lines (
    transfer_request_id, destination_organization_id, central_item_id,
    scientific_name, concentration, dosage_form, unit,
    requested_quantity, notes
  ) VALUES (
    v_request.id, v_request.destination_organization_id, p_central_item_id,
    v_name, NULLIF(btrim(p_concentration), ''), NULLIF(btrim(p_dosage_form), ''),
    NULLIF(btrim(p_unit), ''), p_requested_quantity, NULLIF(btrim(p_notes), '')
  )
  RETURNING id INTO v_line_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.destination_organization_id, v_actor,
    (SELECT role FROM public.profiles WHERE id = v_actor),
    'warehouse_transfer.request_line_added', 'warehouse_transfer_request_lines', v_line_id, v_name,
    jsonb_build_object('transfer_request_id', v_request.id, 'requested_quantity', p_requested_quantity,
                       'direct', v_request.route_id IS NULL)
  );

  RETURN jsonb_build_object('ok', true, 'transfer_request_line_id', v_line_id);
END;
$$;

-- Shared authorization for request-build writes: SOURCE-scoped for a direct
-- (route_id NULL) request, DESTINATION-scoped for a legacy routed request. This
-- is the ONLY authorization difference the direct build phase introduces.
CREATE OR REPLACE FUNCTION public._phoenix_authorize_transfer_request_write(
  p_actor   uuid,
  p_request public.warehouse_transfer_requests
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_request.route_id IS NULL THEN
    -- Direct push: the central source owns the whole build.
    PERFORM public.phoenix_assert_direct_supply_endpoints(
      p_request.source_warehouse_id, p_request.destination_warehouse_id,
      p_request.destination_organization_id);
    IF NOT public.phoenix_profile_has_scoped_permission(
      p_actor, 'warehouse_transfer.send',
      p_request.source_organization_id, p_request.source_warehouse_id, NULL
    ) THEN
      RAISE EXCEPTION 'forbidden_direct_warehouse_transfer' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Legacy routed: the institution destination owns the request (068).
    IF NOT public.phoenix_profile_has_scoped_permission(
      p_actor, 'warehouse_transfer.request',
      p_request.destination_organization_id, p_request.destination_warehouse_id, NULL
    ) THEN
      RAISE EXCEPTION 'forbidden_warehouse_transfer_request' USING ERRCODE = '42501';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_authorize_transfer_request_write(uuid, public.warehouse_transfer_requests) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._phoenix_authorize_transfer_request_write(uuid, public.warehouse_transfer_requests) TO authenticated;

-- 4b. UPDATE LINE
CREATE OR REPLACE FUNCTION public.phoenix_update_warehouse_transfer_request_line(
  p_transfer_request_line_id uuid,
  p_requested_quantity       integer,
  p_notes                    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_line    public.warehouse_transfer_request_lines%ROWTYPE;
  v_request public.warehouse_transfer_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_transfer_request_line_id IS NULL THEN
    RAISE EXCEPTION 'transfer_request_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_requested_quantity IS NULL OR p_requested_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_line
  FROM public.warehouse_transfer_request_lines WHERE id = p_transfer_request_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_request_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_request
  FROM public.warehouse_transfer_requests WHERE id = v_line.transfer_request_id FOR UPDATE;

  PERFORM public._phoenix_authorize_transfer_request_write(v_actor, v_request);

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'transfer_request_not_draft' USING ERRCODE = '23514';
  END IF;

  UPDATE public.warehouse_transfer_request_lines
     SET requested_quantity = p_requested_quantity,
         notes = COALESCE(NULLIF(btrim(p_notes), ''), notes)
   WHERE id = v_line.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.destination_organization_id, v_actor,
    (SELECT role FROM public.profiles WHERE id = v_actor),
    'warehouse_transfer.request_line_updated', 'warehouse_transfer_request_lines', v_line.id,
    v_line.scientific_name,
    jsonb_build_object('previous_quantity', v_line.requested_quantity, 'new_quantity', p_requested_quantity)
  );

  RETURN jsonb_build_object('ok', true, 'transfer_request_line_id', v_line.id);
END;
$$;

-- 4c. DELETE LINE
CREATE OR REPLACE FUNCTION public.phoenix_delete_warehouse_transfer_request_line(
  p_transfer_request_line_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_line    public.warehouse_transfer_request_lines%ROWTYPE;
  v_request public.warehouse_transfer_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_transfer_request_line_id IS NULL THEN
    RAISE EXCEPTION 'transfer_request_line_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_line
  FROM public.warehouse_transfer_request_lines WHERE id = p_transfer_request_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_request_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_request
  FROM public.warehouse_transfer_requests WHERE id = v_line.transfer_request_id FOR UPDATE;

  PERFORM public._phoenix_authorize_transfer_request_write(v_actor, v_request);

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'transfer_request_not_draft' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.destination_organization_id, v_actor,
    (SELECT role FROM public.profiles WHERE id = v_actor),
    'warehouse_transfer.request_line_deleted', 'warehouse_transfer_request_lines', v_line.id,
    v_line.scientific_name,
    jsonb_build_object('transfer_request_id', v_request.id, 'requested_quantity', v_line.requested_quantity)
  );

  DELETE FROM public.warehouse_transfer_request_lines WHERE id = v_line.id;

  RETURN jsonb_build_object('ok', true, 'deleted', true, 'transfer_request_line_id', v_line.id);
END;
$$;

-- 4d. SUBMIT — draft -> submitted.
CREATE OR REPLACE FUNCTION public.phoenix_submit_warehouse_transfer_request(
  p_transfer_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_request    public.warehouse_transfer_requests%ROWTYPE;
  v_route      public.warehouse_supply_routes%ROWTYPE;
  v_line_count integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_transfer_request_id IS NULL THEN
    RAISE EXCEPTION 'transfer_request_id_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_transfer_request_id::text, 68069));

  SELECT * INTO v_request
  FROM public.warehouse_transfer_requests WHERE id = p_transfer_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._phoenix_authorize_transfer_request_write(v_actor, v_request);

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'transfer_request_not_draft' USING ERRCODE = '23514';
  END IF;

  IF v_request.route_id IS NOT NULL THEN
    -- Legacy routed: the route must still be ACTIVE at submit (068 §8e).
    SELECT * INTO v_route
    FROM public.warehouse_supply_routes WHERE id = v_request.route_id FOR SHARE;
    IF NOT FOUND OR NOT v_route.is_active THEN
      RAISE EXCEPTION 'supply_route_inactive' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Direct: endpoints were re-asserted (active central/institution) by the
  -- authorization helper above; no route to check.

  SELECT count(*) INTO v_line_count
  FROM public.warehouse_transfer_request_lines WHERE transfer_request_id = v_request.id;
  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'transfer_request_has_no_lines' USING ERRCODE = '23514';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  UPDATE public.warehouse_transfer_requests
     SET status = 'submitted', requested_by = v_actor, requested_at = now()
   WHERE id = v_request.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.destination_organization_id, v_actor, v_actor_role,
    'warehouse_transfer.request_submitted', 'warehouse_transfer_requests', v_request.id,
    v_request.request_number,
    jsonb_build_object('line_count', v_line_count, 'direct', v_request.route_id IS NULL)
  );

  RETURN jsonb_build_object('ok', true, 'transfer_request_id', v_request.id, 'status', 'submitted');
END;
$$;

-- 4e. CANCEL — before review/send only.
CREATE OR REPLACE FUNCTION public.phoenix_cancel_warehouse_transfer_request(
  p_transfer_request_id uuid,
  p_cancellation_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_request    public.warehouse_transfer_requests%ROWTYPE;
  v_reason     text := NULLIF(btrim(p_cancellation_reason), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_transfer_request_id IS NULL THEN
    RAISE EXCEPTION 'transfer_request_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'cancellation_reason_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_transfer_request_id::text, 68069));

  SELECT * INTO v_request
  FROM public.warehouse_transfer_requests WHERE id = p_transfer_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._phoenix_authorize_transfer_request_write(v_actor, v_request);

  IF v_request.status NOT IN ('draft', 'submitted') THEN
    RAISE EXCEPTION 'transfer_request_not_cancellable' USING ERRCODE = '23514';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  UPDATE public.warehouse_transfer_requests
     SET status = 'cancelled', cancelled_by = v_actor, cancelled_at = now(),
         cancellation_reason = v_reason
   WHERE id = v_request.id;

  UPDATE public.warehouse_transfer_request_lines
     SET status = 'cancelled'
   WHERE transfer_request_id = v_request.id AND status = 'pending';

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.destination_organization_id, v_actor, v_actor_role,
    'warehouse_transfer.request_cancelled', 'warehouse_transfer_requests', v_request.id,
    v_request.request_number,
    jsonb_build_object('reason', v_reason, 'previous_status', v_request.status)
  );

  RETURN jsonb_build_object('ok', true, 'transfer_request_id', v_request.id, 'status', 'cancelled');
END;
$$;

-- 4f. REVIEW — the source (central) side decides, line by line. Already
-- SOURCE-scoped in 068; the ONLY change is that the route active-check is
-- skipped when route_id IS NULL (direct requests have no route). Endpoints are
-- re-asserted for direct approvals so a warehouse deactivated between submit
-- and review cannot receive an approval.
CREATE OR REPLACE FUNCTION public.phoenix_review_warehouse_transfer_request(
  p_transfer_request_id uuid,
  p_decisions           jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor          uuid := auth.uid();
  v_actor_role     text;
  v_request        public.warehouse_transfer_requests%ROWTYPE;
  v_route          public.warehouse_supply_routes%ROWTYPE;
  v_route_ok       boolean;
  v_decision       jsonb;
  v_line_id        uuid;
  v_approved_qty   integer;
  v_line           public.warehouse_transfer_request_lines%ROWTYPE;
  v_pending_ids    uuid[];
  v_decided_ids    uuid[] := ARRAY[]::uuid[];
  v_approved_count integer := 0;
  v_rejected_count integer := 0;
  v_full_count     integer := 0;
  v_header_status  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_transfer_request_id IS NULL THEN
    RAISE EXCEPTION 'transfer_request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_decisions IS NULL OR jsonb_typeof(p_decisions) <> 'array' OR jsonb_array_length(p_decisions) = 0 THEN
    RAISE EXCEPTION 'decisions_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_transfer_request_id::text, 68069));

  SELECT * INTO v_request
  FROM public.warehouse_transfer_requests WHERE id = p_transfer_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- THE IDOR GATE and separation of duty: authority scoped to the SOURCE
  -- warehouse (unchanged from 068 — identical for routed and direct).
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.review',
    v_request.source_organization_id, v_request.source_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_transfer_review' USING ERRCODE = '42501';
  END IF;

  IF v_request.status <> 'submitted' THEN
    RAISE EXCEPTION 'transfer_request_not_submitted' USING ERRCODE = '23514';
  END IF;

  IF v_request.route_id IS NOT NULL THEN
    SELECT * INTO v_route
    FROM public.warehouse_supply_routes WHERE id = v_request.route_id FOR SHARE;
    v_route_ok := FOUND AND v_route.is_active;
  ELSE
    -- Direct: "feasible to approve" = endpoints are still an active corridor.
    BEGIN
      PERFORM public.phoenix_assert_direct_supply_endpoints(
        v_request.source_warehouse_id, v_request.destination_warehouse_id,
        v_request.destination_organization_id);
      v_route_ok := true;
    EXCEPTION WHEN OTHERS THEN
      v_route_ok := false;
    END;
  END IF;

  SELECT array_agg(id) INTO v_pending_ids
  FROM (
    SELECT id FROM public.warehouse_transfer_request_lines
    WHERE transfer_request_id = v_request.id AND status = 'pending'
    FOR UPDATE
  ) locked_lines;

  IF v_pending_ids IS NULL THEN
    RAISE EXCEPTION 'transfer_request_has_no_pending_lines' USING ERRCODE = '23514';
  END IF;

  FOR v_decision IN SELECT * FROM jsonb_array_elements(p_decisions)
  LOOP
    v_line_id      := NULLIF(v_decision->>'line_id', '')::uuid;
    v_approved_qty := NULLIF(v_decision->>'approved_quantity', '')::integer;

    IF v_line_id IS NULL OR v_approved_qty IS NULL OR v_approved_qty < 0 THEN
      RAISE EXCEPTION 'invalid_review_decision' USING ERRCODE = '23514';
    END IF;
    IF NOT (v_line_id = ANY (v_pending_ids)) THEN
      RAISE EXCEPTION 'decision_line_not_pending_for_request' USING ERRCODE = 'P0002';
    END IF;
    IF v_line_id = ANY (v_decided_ids) THEN
      RAISE EXCEPTION 'duplicate_decision_for_line' USING ERRCODE = '23505';
    END IF;

    SELECT * INTO v_line FROM public.warehouse_transfer_request_lines WHERE id = v_line_id;
    IF v_approved_qty > v_line.requested_quantity THEN
      RAISE EXCEPTION 'approved_quantity_exceeds_requested' USING ERRCODE = '23514';
    END IF;
    -- Only an APPROVAL needs a feasible corridor; a rejection (0) never moves
    -- stock, so a deactivated route / inactive endpoint must not block it.
    IF v_approved_qty > 0 AND NOT v_route_ok THEN
      RAISE EXCEPTION 'supply_corridor_inactive' USING ERRCODE = '23514';
    END IF;

    UPDATE public.warehouse_transfer_request_lines
       SET approved_quantity = v_approved_qty,
           status = CASE WHEN v_approved_qty = 0 THEN 'rejected' ELSE 'approved' END
     WHERE id = v_line_id;

    v_decided_ids := array_append(v_decided_ids, v_line_id);
    IF v_approved_qty = 0 THEN
      v_rejected_count := v_rejected_count + 1;
    ELSE
      v_approved_count := v_approved_count + 1;
      IF v_approved_qty = v_line.requested_quantity THEN
        v_full_count := v_full_count + 1;
      END IF;
    END IF;
  END LOOP;

  IF array_length(v_decided_ids, 1) IS DISTINCT FROM array_length(v_pending_ids, 1) THEN
    RAISE EXCEPTION 'all_pending_lines_must_be_decided' USING ERRCODE = '23514';
  END IF;

  v_header_status := CASE
    WHEN v_approved_count = 0 THEN 'rejected'
    WHEN v_rejected_count = 0 AND v_full_count = v_approved_count THEN 'approved'
    ELSE 'partially_approved'
  END;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  UPDATE public.warehouse_transfer_requests
     SET status = v_header_status, reviewed_by = v_actor, reviewed_at = now()
   WHERE id = v_request.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.source_organization_id, v_actor, v_actor_role,
    'warehouse_transfer.request_reviewed', 'warehouse_transfer_requests', v_request.id,
    v_request.request_number,
    jsonb_build_object('decisions', p_decisions, 'result_status', v_header_status,
                       'direct', v_request.route_id IS NULL)
  );

  RETURN jsonb_build_object('ok', true, 'transfer_request_id', v_request.id, 'status', v_header_status);
END;
$$;

-- ============================================================================
-- 5. DIRECT SEND — stock leaves the central warehouse, no route
-- ============================================================================
-- Mirrors phoenix_send_warehouse_transfer_line (068 §9) exactly, EXCEPT the two
-- endpoints come from the pinned direct request (route_id must be NULL) instead
-- of a route, the transfer header is written with route_id NULL, and the
-- request-line match is by transfer_request_id rather than route_id. Same
-- advisory-lock-first / row-lock-second discipline, same idempotency by
-- (reference_type, reference_id) + fingerprint, same source-scoped authority,
-- same negative-stock / reserved / expiry refusals, same ledger + audit rows.
CREATE OR REPLACE FUNCTION public.phoenix_send_direct_warehouse_transfer_line(
  p_request_id               uuid,   -- idempotency token for THIS send
  p_transfer_request_id      uuid,   -- the direct request being fulfilled
  p_warehouse_stock_id       uuid,
  p_quantity                 integer,
  p_transfer_number          text,
  p_transfer_request_line_id uuid DEFAULT NULL,
  p_document_number          text DEFAULT NULL,
  p_notes                    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_actor_name   text;
  v_req          public.warehouse_transfer_requests%ROWTYPE;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_src_org      uuid;
  v_dest_org     uuid;
  v_transfer     public.warehouse_transfers%ROWTYPE;
  v_existing     public.warehouse_stock_movements%ROWTYPE;
  v_reqline      public.warehouse_transfer_request_lines%ROWTYPE;
  v_number       text := NULLIF(btrim(p_transfer_number), '');
  v_doc          text := NULLIF(btrim(p_document_number), '');
  v_notes        text := NULLIF(btrim(p_notes), '');
  v_before       integer;
  v_after        integer;
  v_line_id      uuid;
  v_movement_id  uuid;
  v_fingerprint  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_transfer_request_id IS NULL THEN
    RAISE EXCEPTION 'request_and_transfer_request_required' USING ERRCODE = '23514';
  END IF;
  IF p_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_stock_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'transfer_number_required' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'direct_transfer_send',
    'transfer_request_id', p_transfer_request_id,
    'warehouse_stock_id', p_warehouse_stock_id,
    'quantity', p_quantity,
    'transfer_number', v_number,
    'transfer_request_line_id', p_transfer_request_line_id,
    'document_number', v_doc,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 68068));

  SELECT * INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'warehouse_transfer_send' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.warehouse_stock_id IS DISTINCT FROM p_warehouse_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'warehouse_stock_id', v_existing.warehouse_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  -- The direct request pins the endpoints. It MUST be a direct (route_id NULL)
  -- request in a sendable state.
  SELECT * INTO v_req
  FROM public.warehouse_transfer_requests WHERE id = p_transfer_request_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.route_id IS NOT NULL THEN
    RAISE EXCEPTION 'not_a_direct_request' USING ERRCODE = '23514';
  END IF;
  IF v_req.status NOT IN ('approved', 'partially_approved', 'partially_fulfilled') THEN
    RAISE EXCEPTION 'transfer_request_not_approved' USING ERRCODE = '23514';
  END IF;

  -- Endpoints still an active central->institution corridor (re-asserted, and
  -- the two warehouse rows locked FOR SHARE against concurrent deactivation).
  SELECT o_source_organization_id, o_destination_organization_id
    INTO v_src_org, v_dest_org
  FROM public.phoenix_assert_direct_supply_endpoints(
         v_req.source_warehouse_id, v_req.destination_warehouse_id,
         v_req.destination_organization_id);

  SELECT * INTO v_stock
  FROM public.warehouse_stock WHERE id = p_warehouse_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- The stock must sit in the request's SOURCE warehouse — the IDOR gate that
  -- the route's source_warehouse_id gave the legacy path.
  IF v_stock.warehouse_id IS DISTINCT FROM v_req.source_warehouse_id THEN
    RAISE EXCEPTION 'stock_not_in_source_warehouse' USING ERRCODE = '42501';
  END IF;

  -- Authority: the actor's scoped assignment to the SOURCE warehouse.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.send', v_stock.organization_id, v_stock.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_transfer_send' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF v_stock.expiry_date IS NOT NULL AND v_stock.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_sent' USING ERRCODE = '23514';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;
  IF v_after < 0 THEN
    RAISE EXCEPTION 'warehouse_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  IF v_after < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'warehouse_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_transfer
  FROM public.warehouse_transfers
  WHERE source_organization_id = v_stock.organization_id
    AND btrim(transfer_number) = v_number
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.warehouse_transfers (
      route_id, transfer_request_id,
      source_warehouse_id, source_organization_id,
      destination_warehouse_id, destination_organization_id,
      transfer_number, status, document_number, notes, sent_by, sent_at
    ) VALUES (
      NULL, NULL,
      v_req.source_warehouse_id, v_stock.organization_id,
      v_req.destination_warehouse_id, v_dest_org,
      v_number, 'in_transit', v_doc, v_notes, v_actor, now()
    )
    RETURNING * INTO v_transfer;
  ELSE
    -- An existing direct shipment must not be re-pointed at a routed transfer,
    -- nor at a different source/destination.
    IF v_transfer.route_id IS NOT NULL
       OR v_transfer.source_warehouse_id IS DISTINCT FROM v_req.source_warehouse_id
       OR v_transfer.destination_warehouse_id IS DISTINCT FROM v_req.destination_warehouse_id THEN
      RAISE EXCEPTION 'transfer_number_endpoint_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_transfer.status <> 'in_transit' THEN
      RAISE EXCEPTION 'transfer_already_being_received' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF p_transfer_request_line_id IS NOT NULL THEN
    SELECT l.* INTO v_reqline
    FROM public.warehouse_transfer_request_lines l
    WHERE l.id = p_transfer_request_line_id AND l.transfer_request_id = v_req.id
    FOR UPDATE OF l;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'request_line_not_found_for_request' USING ERRCODE = 'P0002';
    END IF;
    IF v_reqline.status NOT IN ('approved', 'partially_fulfilled') THEN
      RAISE EXCEPTION 'request_line_not_approved' USING ERRCODE = '23514';
    END IF;
    IF v_reqline.fulfilled_quantity + p_quantity > v_reqline.approved_quantity THEN
      RAISE EXCEPTION 'request_line_would_be_over_fulfilled' USING ERRCODE = '23514';
    END IF;

    UPDATE public.warehouse_transfer_request_lines
       SET fulfilled_quantity = fulfilled_quantity + p_quantity,
           status = CASE WHEN fulfilled_quantity + p_quantity >= approved_quantity
                         THEN 'fulfilled' ELSE 'partially_fulfilled' END
     WHERE id = v_reqline.id;

    UPDATE public.warehouse_transfer_requests
       SET status = CASE WHEN NOT EXISTS (
                           SELECT 1 FROM public.warehouse_transfer_request_lines x
                           WHERE x.transfer_request_id = v_reqline.transfer_request_id
                             AND x.status NOT IN ('fulfilled', 'rejected', 'cancelled'))
                         THEN 'fulfilled' ELSE 'partially_fulfilled' END
     WHERE id = v_reqline.transfer_request_id;

    UPDATE public.warehouse_transfers
       SET transfer_request_id = COALESCE(transfer_request_id, v_reqline.transfer_request_id)
     WHERE id = v_transfer.id;
  END IF;

  UPDATE public.warehouse_stock
     SET on_hand_quantity = v_after,
         updated_by       = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_transfer_lines (
    transfer_id, source_organization_id, source_warehouse_stock_id,
    transfer_request_line_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, unit_price, price_basis, currency, supply_type_text,
    sent_quantity, status
  ) VALUES (
    v_transfer.id, v_stock.organization_id, v_stock.id,
    p_transfer_request_line_id, v_stock.central_item_id,
    v_stock.scientific_name, v_stock.trade_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.has_no_national_code,
    v_stock.batch_number, v_stock.has_no_batch_number, v_stock.internal_batch_reference,
    v_stock.expiry_date, v_stock.unit_price, v_stock.price_basis,
    v_stock.currency, v_stock.supply_type_text,
    p_quantity, 'in_transit'
  )
  RETURNING id INTO v_line_id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id, movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'dispatch_send',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'warehouse_transfer_send', 'warehouse_transfer_send', p_request_id, v_fingerprint,
    v_doc, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference
  )
  RETURNING id INTO v_movement_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_stock.organization_id, v_actor, v_actor_role,
    'warehouse_transfer.send', 'warehouse_transfer_lines', v_line_id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'direct', true,
      'transfer_request_id', v_req.id,
      'transfer_id', v_transfer.id,
      'source_warehouse_id', v_req.source_warehouse_id,
      'destination_warehouse_id', v_req.destination_warehouse_id,
      'movement_id', v_movement_id,
      'quantity_before', v_before,
      'quantity_delta', -p_quantity,
      'quantity_after', v_after
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'transfer_id', v_transfer.id,
    'transfer_line_id', v_line_id,
    'warehouse_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'in_transit_quantity', p_quantity,
    'quantity_before', v_before,
    'quantity_delta', -p_quantity,
    'quantity_after', v_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_send_direct_warehouse_transfer_line(uuid, uuid, uuid, integer, text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_send_direct_warehouse_transfer_line(uuid, uuid, uuid, integer, text, uuid, text, text) TO authenticated;

-- ============================================================================
-- 6. INVENTORY INTELLIGENCE (072) — feasibility without warehouse_supply_routes
-- ============================================================================
-- 6a. The suggestion GUARD: the central_to_institution corridor is proven by an
-- active central source + active institution target in the right organizations,
-- NOT by an active supply route. Every other branch is preserved verbatim.
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
    OR NEW.source_scope_id   IS DISTINCT FROM OLD.source_scope_id
    OR NEW.target_scope_kind IS DISTINCT FROM OLD.target_scope_kind
    OR NEW.target_scope_id   IS DISTINCT FROM OLD.target_scope_id
    OR NEW.route_kind        IS DISTINCT FROM OLD.route_kind
    OR NEW.source_organization_id IS DISTINCT FROM OLD.source_organization_id
    OR NEW.target_organization_id IS DISTINCT FROM OLD.target_organization_id
    OR NEW.source_stock_id   IS DISTINCT FROM OLD.source_stock_id
    OR NEW.scientific_name   IS DISTINCT FROM OLD.scientific_name
    OR NEW.national_code     IS DISTINCT FROM OLD.national_code
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
      ) THEN
        RAISE EXCEPTION 'guard_072_no_warehouse_outlet_pairing';
      END IF;
    ELSIF NEW.route_kind = 'outlet_to_warehouse' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.distribution_points dp
        WHERE dp.id = NEW.source_scope_id
          AND dp.warehouse_id = NEW.target_scope_id
          AND dp.organization_id = NEW.source_organization_id
      ) THEN
        RAISE EXCEPTION 'guard_072_no_outlet_warehouse_pairing';
      END IF;
    ELSIF NEW.route_kind = 'central_to_institution' THEN
      -- 077: route-free feasibility — an active central source and an active
      -- institution target in the stated organizations (no supply-route lookup).
      IF NOT EXISTS (
        SELECT 1
        FROM public.warehouses sw
        JOIN public.warehouses tw ON tw.id = NEW.target_scope_id
        WHERE sw.id = NEW.source_scope_id
          AND sw.warehouse_kind = 'central'     AND sw.status = 'active'
          AND sw.organization_id = NEW.source_organization_id
          AND tw.warehouse_kind = 'institution' AND tw.status = 'active'
          AND tw.organization_id = NEW.target_organization_id
      ) THEN
        RAISE EXCEPTION 'guard_072_no_active_central_institution_pairing';
      END IF;
    ELSE
      RAISE EXCEPTION 'guard_072_invalid_route_kind';
    END IF;
  END IF;

  -- CONSERVATION UNDER REAL LEDGER LOCKS — reproduced verbatim from 072 (Round 5,
  -- items 1/2/4) so nothing is weakened. Only the corridor arm above changed.
  IF v_conservation_write AND NEW.status IN ('open', 'accepted') THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('inv_stock:' || NEW.source_stock_id::text, 0));
    IF NEW.route_kind = 'outlet_to_warehouse' THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('inv_provline:' || NEW.provenance_dispatch_line_id::text, 0));
    END IF;

    -- Real stock row FOR SHARE — ALSO the authoritative batch identity re-check
    -- (existence, right table, scope, org, material, code-when-coded, unexpired).
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

    SELECT COALESCE(SUM(s.suggested_quantity), 0) INTO v_committed
    FROM public.inventory_transfer_suggestions s
    WHERE s.source_stock_id = NEW.source_stock_id
      AND s.status IN ('open', 'accepted')
      AND s.id <> NEW.id;

    IF v_committed + NEW.suggested_quantity > v_available THEN
      RAISE EXCEPTION 'guard_072_batch_oversubscribed';
    END IF;

    IF NEW.route_kind = 'outlet_to_warehouse' THEN
      SELECT COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity
        INTO v_returnable
      FROM public.warehouse_dispatch_lines wdl
      WHERE wdl.id = NEW.provenance_dispatch_line_id
        AND wdl.status IN ('accepted', 'accepted_with_difference')
      FOR SHARE;
      IF v_returnable IS NULL THEN
        RAISE EXCEPTION 'guard_072_exceeds_returnable_quantity';
      END IF;

      SELECT COALESCE(SUM(s.suggested_quantity), 0) INTO v_committed_line
      FROM public.inventory_transfer_suggestions s
      WHERE s.provenance_dispatch_line_id = NEW.provenance_dispatch_line_id
        AND s.status IN ('open', 'accepted')
        AND s.id <> NEW.id;

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
    ) THEN
      RAISE EXCEPTION 'guard_072_exchange_request_mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Re-attach the guard trigger (idempotent) so the REPLACE'd body is bound.
DROP TRIGGER IF EXISTS inventory_suggestion_guard ON public.inventory_transfer_suggestions;
CREATE TRIGGER inventory_suggestion_guard
  BEFORE INSERT OR UPDATE ON public.inventory_transfer_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_inventory_suggestion_guard();

-- 6b. The recompute: central_to_institution feasibility no longer consults
-- warehouse_supply_routes. Candidates remain alert-driven (from _need / _src),
-- so the pass is O(alerts), never O(warehouses^2). Only the route_kind CASE arm
-- changes; the allocator, FEFO, conservation and upsert are untouched.
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
  SET status = 'superseded', updated_at = now()
  WHERE s.source_organization_id = p_organization_id
    AND s.target_organization_id = p_organization_id
    AND s.status = 'open'
    AND EXISTS (SELECT 1 FROM _scopes sc
                WHERE sc.scope_kind = s.source_scope_kind AND sc.scope_id = s.source_scope_id)
    AND EXISTS (SELECT 1 FROM _scopes sc
                WHERE sc.scope_kind = s.target_scope_kind AND sc.scope_id = s.target_scope_id);
  GET DIAGNOSTICS v_superseded = ROW_COUNT;

  CREATE TEMP TABLE _need ON COMMIT DROP AS
    SELECT a.id AS alert_id, a.scope_kind, a.scope_id,
           a.scientific_name, lower(a.scientific_name) AS sci_lower, a.national_code,
           GREATEST(COALESCE(a.threshold_reorder_point, 0) - COALESCE(a.observed_available, 0), 1) AS deficit,
           GREATEST(COALESCE(a.threshold_reorder_point, 0) - COALESCE(a.observed_available, 0), 1)
             - COALESCE((
                 SELECT SUM(s.suggested_quantity)
                 FROM public.inventory_transfer_suggestions s
                 WHERE s.target_scope_kind = a.scope_kind
                   AND s.target_scope_id = a.scope_id
                   AND s.target_organization_id = a.organization_id
                   AND lower(s.scientific_name) = lower(a.scientific_name)
                   AND s.national_code IS NOT DISTINCT FROM a.national_code
                   AND s.status IN ('open', 'accepted')
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
                 SELECT SUM(s.suggested_quantity)
                 FROM public.inventory_transfer_suggestions s
                 WHERE s.source_scope_kind = a.scope_kind
                   AND s.source_scope_id = a.scope_id
                   AND s.source_organization_id = a.organization_id
                   AND lower(s.scientific_name) = lower(a.scientific_name)
                   AND s.national_code IS NOT DISTINCT FROM a.national_code
                   AND s.status IN ('open', 'accepted')
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
                 SELECT SUM(s.suggested_quantity)
                 FROM public.inventory_transfer_suggestions s
                 WHERE s.source_stock_id = b.stock_id
                   AND s.provenance_dispatch_line_id IS NOT DISTINCT FROM b.dispatch_line_id
                   AND s.status IN ('open', 'accepted')
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
                 SELECT SUM(s.suggested_quantity)
                 FROM public.inventory_transfer_suggestions s
                 WHERE s.source_stock_id = b.stock_id
                   AND s.status IN ('open', 'accepted')
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
               -- 077: central->institution feasibility WITHOUT a supply route.
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
        ON CONFLICT (suggestion_key) DO UPDATE SET
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
          updated_at                      = now(),
          status                          = 'open'
        WHERE su.status IN ('open', 'superseded', 'expired');

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        -- An accepted/rejected row keeps its key: nothing was written, and its
        -- quantity was already counted as consumed headroom above.
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

REVOKE ALL ON FUNCTION public.phoenix_suggest_inventory_transfers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_suggest_inventory_transfers(uuid) TO authenticated;

-- 6c. CROSS-ORG SUGGESTION (072 §11) — route-free feasibility.
-- The privileged super_admin cross-ORG minting path no longer consults a supply
-- route. Feasibility is now "an active central source + an active institution
-- target, each owned by its claimed organization" (warehouse_kind + status),
-- the same corridor test the intra-org engine uses. EVERYTHING else — the
-- data-derived quantities (no quantity parameter), the dual-org deterministic
-- lock order, the real surplus/shortfall alert requirement, the FEFO batch loop
-- with per-batch remaining caps, and recommendation-only (acceptance disabled,
-- §12) — is 072 §11 unchanged. Mints NO stock movement.
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

  -- Deterministic dual-org lock order (sorted): concurrent suggest runs in
  -- either organization serialize against this computation.
  v_lock_a := LEAST(p_source_organization_id::text, p_target_organization_id::text);
  v_lock_b := GREATEST(p_source_organization_id::text, p_target_organization_id::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('inv_suggest:' || v_lock_a, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('inv_suggest:' || v_lock_b, 0));

  -- 077: route-free feasibility — an active central source + active institution
  -- target, each owned by its claimed organization (no supply-route lookup).
  IF NOT EXISTS (
    SELECT 1
    FROM public.warehouses sw
    JOIN public.warehouses tw ON tw.id = p_target_warehouse_id
    WHERE sw.id = p_source_warehouse_id
      AND sw.warehouse_kind = 'central'     AND sw.status = 'active'
      AND sw.organization_id = p_source_organization_id
      AND tw.warehouse_kind = 'institution' AND tw.status = 'active'
      AND tw.organization_id = p_target_organization_id
  ) THEN
    RAISE EXCEPTION 'no_active_central_institution_pairing';
  END IF;

  -- STABLE RERUN (Round 4): supersede THIS run's own prior open rows for this
  -- exact corridor tuple FIRST, so the "remaining" computations below do not
  -- subtract the very suggestions this run is about to rebuild. Superseded rows
  -- are excluded from the open+accepted SUMs and reopened by ON CONFLICT if
  -- still valid. Both org locks are already held, so this is atomic.
  UPDATE public.inventory_transfer_suggestions s
  SET status = 'superseded', updated_at = now()
  WHERE s.route_kind = 'central_to_institution'
    AND s.source_organization_id = p_source_organization_id
    AND s.target_organization_id = p_target_organization_id
    AND s.source_scope_kind = 'warehouse' AND s.source_scope_id = p_source_warehouse_id
    AND s.target_scope_kind = 'warehouse' AND s.target_scope_id = p_target_warehouse_id
    AND lower(s.scientific_name) = lower(v_name)
    AND s.national_code IS NOT DISTINCT FROM v_code
    AND s.status = 'open';

  -- REAL surplus at the source (an active surplus alert for this material).
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

  -- REAL shortfall at the target (an active missing/low_stock alert).
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

  -- Remaining = data minus every other still-consuming suggestion.
  v_surplus := v_surplus - COALESCE((
    SELECT SUM(s.suggested_quantity)
    FROM public.inventory_transfer_suggestions s
    WHERE s.source_scope_kind = 'warehouse'
      AND s.source_scope_id = p_source_warehouse_id
      AND s.source_organization_id = p_source_organization_id
      AND lower(s.scientific_name) = lower(v_name)
      AND s.national_code IS NOT DISTINCT FROM v_code
      AND s.status IN ('open', 'accepted')
  ), 0);
  IF v_surplus <= 0 THEN
    RAISE EXCEPTION 'source_surplus_already_committed';
  END IF;

  v_shortfall := v_shortfall - COALESCE((
    SELECT SUM(s.suggested_quantity)
    FROM public.inventory_transfer_suggestions s
    WHERE s.target_scope_kind = 'warehouse'
      AND s.target_scope_id = p_target_warehouse_id
      AND s.target_organization_id = p_target_organization_id
      AND lower(s.scientific_name) = lower(v_name)
      AND s.national_code IS NOT DISTINCT FROM v_code
      AND s.status IN ('open', 'accepted')
  ), 0);
  IF v_shortfall <= 0 THEN
    RAISE EXCEPTION 'target_shortfall_already_covered';
  END IF;

  -- One suggestion per eligible FEFO batch until surplus or shortfall runs
  -- out. No eligible batch at all => no suggestion, by exception.
  FOR v_batch IN
    SELECT ws.id AS stock_id, ws.batch_number, ws.expiry_date, ws.available_quantity
    FROM public.warehouse_stock ws
    WHERE ws.organization_id = p_source_organization_id
      AND ws.warehouse_id = p_source_warehouse_id
      AND lower(ws.scientific_name) = lower(v_name)
      AND (v_code IS NULL OR ws.national_code IS NOT DISTINCT FROM v_code)
      -- WILDCARD request (§6): exclude codes that have their own active coded
      -- threshold at the source warehouse — those are governed by their coded
      -- position and must not be drawn by a wildcard cross-org suggestion.
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
      SELECT SUM(s.suggested_quantity)
      FROM public.inventory_transfer_suggestions s
      WHERE s.source_stock_id = v_batch.stock_id
        AND s.status IN ('open', 'accepted')
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
      'cross-org recommendation: derived from a real surplus alert, a real shortfall alert, an active central->institution pairing and one FEFO batch; recommendation only — acceptance is disabled (act through the 041 exchange RPC path)',
      v_key, 'open', now(), now(), now()
    )
    ON CONFLICT (suggestion_key) DO UPDATE SET
      suggested_quantity              = EXCLUDED.suggested_quantity,
      fefo_batch_number               = EXCLUDED.fefo_batch_number,
      fefo_expiry_date                = EXCLUDED.fefo_expiry_date,
      source_batch_available_snapshot = EXCLUDED.source_batch_available_snapshot,
      source_surplus_snapshot         = EXCLUDED.source_surplus_snapshot,
      target_shortfall_snapshot       = EXCLUDED.target_shortfall_snapshot,
      last_suggested_at               = now(),
      last_validated_at               = now(),
      updated_at                      = now(),
      status                          = 'open'
    WHERE su.status IN ('open', 'superseded', 'expired');

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

REVOKE ALL ON FUNCTION public.phoenix_suggest_cross_org_inventory_transfer(uuid, uuid, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_suggest_cross_org_inventory_transfer(uuid, uuid, uuid, uuid, text, text) TO authenticated;

-- ============================================================================
-- 7. DIRECT RETURN — institution -> central, route-free, provenance-derived
-- ============================================================================
-- The mirror image of the direct forward path. 069 modelled every return as
-- travelling a warehouse_supply_route (route_id NOT NULL + composite FK). 077
-- adds a DIRECT return: the reverse corridor is derived from the ORIGINAL DIRECT
-- FORWARD TRANSFER (provenance), never from a route. A direct return may only be
-- opened between an active institution warehouse and an active central warehouse
-- that a real direct (route_id NULL) forward transfer already connected, and
-- every returned line must name an original transfer line of THAT direct
-- delivery. Everything else — per-line and per-original caps, ledger
-- conservation, idempotency, advisory-lock-first ordering, audit — is 069's
-- contract unchanged. The receive (069 §11, with its fail-closed quarantine
-- classification) is ALREADY route-free and is reused verbatim for direct
-- shipments; no new receive function is defined.
--
-- route_id becomes NULLable on the two 069 return tables HERE — deliberately
-- adjacent to (and never ahead of) the RPCs below that are the only writers of a
-- NULL-route return row. Legacy routed returns keep route_id populated and fully
-- FK-enforced; MATCH SIMPLE exempts only the NULL-route direct rows.
ALTER TABLE public.warehouse_return_requests   ALTER COLUMN route_id DROP NOT NULL;
ALTER TABLE public.warehouse_return_shipments  ALTER COLUMN route_id DROP NOT NULL;

COMMENT ON COLUMN public.warehouse_return_requests.route_id IS
  'NULL for a 077 DIRECT return (endpoints pinned on the row, corridor derived '
  'from the original direct forward transfer). Non-NULL for a legacy 069 routed '
  'return (composite FK to warehouse_supply_routes enforced).';
COMMENT ON COLUMN public.warehouse_return_shipments.route_id IS
  'NULL for a 077 DIRECT return shipment; non-NULL for a legacy 069 routed one.';

CREATE INDEX IF NOT EXISTS wrr_direct_idx
  ON public.warehouse_return_requests (source_warehouse_id, status)
  WHERE route_id IS NULL;
CREATE INDEX IF NOT EXISTS wrs_direct_idx
  ON public.warehouse_return_shipments (destination_warehouse_id, status)
  WHERE route_id IS NULL;

-- 7a. REVERSE-CORRIDOR VALIDATOR — the direct return's replacement for the route
-- FK. Asserts (institution source -> central destination) is a legitimate
-- reverse corridor: source is an ACTIVE institution warehouse, destination is an
-- ACTIVE central warehouse, and a real DIRECT (route_id NULL) forward transfer
-- actually connected central -> institution (the provenance the route used to
-- stand in for). Both warehouse rows are locked FOR SHARE so a concurrent
-- deactivation cannot slip past. Returns the resolved organization ids.
-- Deliberately NOT gated on the ORIGINAL transfer's current state — returning
-- material that already moved must not depend on anything but the endpoints
-- still being an active institution/central pair with real provenance.
CREATE OR REPLACE FUNCTION public.phoenix_assert_direct_return_endpoints(
  p_institution_warehouse_id uuid,   -- return SOURCE
  p_central_warehouse_id     uuid,   -- return DESTINATION
  OUT o_institution_organization_id uuid,
  OUT o_central_organization_id     uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst public.warehouses%ROWTYPE;
  v_cent public.warehouses%ROWTYPE;
BEGIN
  IF p_institution_warehouse_id IS NULL OR p_central_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'source_and_destination_required' USING ERRCODE = '23514';
  END IF;
  IF p_institution_warehouse_id = p_central_warehouse_id THEN
    RAISE EXCEPTION 'source_and_destination_must_differ' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_inst FROM public.warehouses WHERE id = p_institution_warehouse_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_warehouse_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_inst.warehouse_kind <> 'institution' OR v_inst.status <> 'active' THEN
    RAISE EXCEPTION 'source_must_be_active_institution_warehouse' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_cent FROM public.warehouses WHERE id = p_central_warehouse_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_warehouse_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_cent.warehouse_kind <> 'central' OR v_cent.status <> 'active' THEN
    RAISE EXCEPTION 'destination_must_be_active_central_warehouse' USING ERRCODE = '23514';
  END IF;

  -- PROVENANCE: a real direct forward transfer must have connected these two
  -- warehouses. This is what the composite route FK gave the routed path, here
  -- derived from the movement history instead of a pre-approved route.
  IF NOT EXISTS (
    SELECT 1 FROM public.warehouse_transfers tr
    WHERE tr.route_id IS NULL
      AND tr.source_warehouse_id = p_central_warehouse_id
      AND tr.destination_warehouse_id = p_institution_warehouse_id
  ) THEN
    RAISE EXCEPTION 'no_direct_forward_provenance_between_warehouses' USING ERRCODE = '42501';
  END IF;

  o_institution_organization_id := v_inst.organization_id;
  o_central_organization_id     := v_cent.organization_id;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_assert_direct_return_endpoints(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_assert_direct_return_endpoints(uuid, uuid) TO authenticated;

-- 7b. REQUEST (institution-initiated) — the institution asks to send stock back
-- to a central warehouse it was directly supplied from. route_id NULL.
CREATE OR REPLACE FUNCTION public.phoenix_request_direct_warehouse_return(
  p_source_warehouse_id      uuid,   -- the institution (return source)
  p_destination_warehouse_id uuid,   -- the central (return destination)
  p_return_number            text,
  p_notes                    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_src_org     uuid;
  v_dest_org    uuid;
  v_number      text := NULLIF(btrim(p_return_number), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_request     public.warehouse_return_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_source_warehouse_id IS NULL OR p_destination_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'source_and_destination_required' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'return_number_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_source_warehouse_id::text, 69069));

  SELECT o_institution_organization_id, o_central_organization_id
    INTO v_src_org, v_dest_org
  FROM public.phoenix_assert_direct_return_endpoints(
         p_source_warehouse_id, p_destination_warehouse_id);

  -- THE IDOR GATE. The institution side owns the request: authority is the
  -- actor's scoped assignment to the SOURCE (institution) warehouse.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_request', v_src_org, p_source_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_request' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.warehouse_return_requests (
    route_id, source_warehouse_id, source_organization_id,
    destination_warehouse_id, destination_organization_id,
    return_number, status, requested_by_side, notes, created_by
  ) VALUES (
    NULL, p_source_warehouse_id, v_src_org,
    p_destination_warehouse_id, v_dest_org,
    v_number, 'draft', 'receiver', v_notes, v_actor
  )
  RETURNING * INTO v_request;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_src_org, v_actor, v_actor_role,
    'warehouse_transfer.return_requested', 'warehouse_return_requests', v_request.id, v_number,
    jsonb_build_object('direct', true, 'source_warehouse_id', p_source_warehouse_id,
                       'destination_warehouse_id', p_destination_warehouse_id)
  );

  RETURN jsonb_build_object('ok', true, 'return_request_id', v_request.id,
                            'status', v_request.status, 'direct', true);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_request_direct_warehouse_return(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_request_direct_warehouse_return(uuid, uuid, text, text) TO authenticated;

-- 7c. RECALL (central-initiated) — central asks the institution to send stock
-- back. Same row/lifecycle; only requested_by_side and the permission gate
-- differ (scoped to central's own DESTINATION warehouse).
CREATE OR REPLACE FUNCTION public.phoenix_recall_direct_warehouse_transfer(
  p_source_warehouse_id      uuid,   -- the institution (return source)
  p_destination_warehouse_id uuid,   -- the central (return destination)
  p_return_number            text,
  p_notes                    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_src_org     uuid;
  v_dest_org    uuid;
  v_number      text := NULLIF(btrim(p_return_number), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_request     public.warehouse_return_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_source_warehouse_id IS NULL OR p_destination_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'source_and_destination_required' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'return_number_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_source_warehouse_id::text, 69069));

  SELECT o_institution_organization_id, o_central_organization_id
    INTO v_src_org, v_dest_org
  FROM public.phoenix_assert_direct_return_endpoints(
         p_source_warehouse_id, p_destination_warehouse_id);

  -- THE IDOR GATE. A recall is central exercising authority over ITS OWN
  -- warehouse's incoming returns: authority scoped to the DESTINATION (central)
  -- warehouse, never the institution's.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.recall', v_dest_org, p_destination_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_recall' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.warehouse_return_requests (
    route_id, source_warehouse_id, source_organization_id,
    destination_warehouse_id, destination_organization_id,
    return_number, status, requested_by_side, notes, created_by
  ) VALUES (
    NULL, p_source_warehouse_id, v_src_org,
    p_destination_warehouse_id, v_dest_org,
    v_number, 'draft', 'sender', v_notes, v_actor
  )
  RETURNING * INTO v_request;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_dest_org, v_actor, v_actor_role,
    'warehouse_transfer.recall_requested', 'warehouse_return_requests', v_request.id, v_number,
    jsonb_build_object('direct', true, 'source_warehouse_id', p_source_warehouse_id,
                       'destination_warehouse_id', p_destination_warehouse_id)
  );

  RETURN jsonb_build_object('ok', true, 'return_request_id', v_request.id,
                            'status', v_request.status, 'direct', true);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_recall_direct_warehouse_transfer(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_recall_direct_warehouse_transfer(uuid, uuid, text, text) TO authenticated;

-- 7d. ADD LINE (direct) — names an EXACT prior receipt from a DIRECT forward
-- delivery on this corridor, bounded by what THAT original line has left to
-- return. The provenance link (original line's transfer is direct and its
-- endpoints match the pinned return corridor) is what makes a route unnecessary.
CREATE OR REPLACE FUNCTION public.phoenix_add_direct_warehouse_return_request_line(
  p_return_request_id         uuid,
  p_original_transfer_line_id uuid,
  p_requested_quantity        integer,
  p_reason_code               text,
  p_reason_text               text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor     uuid := auth.uid();
  v_request   public.warehouse_return_requests%ROWTYPE;
  v_orig      public.warehouse_transfer_lines%ROWTYPE;
  v_transfer  public.warehouse_transfers%ROWTYPE;
  v_remaining integer;
  v_line_id   uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL OR p_original_transfer_line_id IS NULL THEN
    RAISE EXCEPTION 'request_and_original_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_requested_quantity IS NULL OR p_requested_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF p_reason_code IS NULL THEN
    RAISE EXCEPTION 'reason_code_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.warehouse_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_request.route_id IS NOT NULL THEN
    RAISE EXCEPTION 'not_a_direct_return' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_request',
    v_request.source_organization_id, v_request.source_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_request' USING ERRCODE = '42501';
  END IF;

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'return_request_not_draft' USING ERRCODE = '23514';
  END IF;

  -- Lock the original receipt while reading its remaining returnable quantity.
  SELECT * INTO v_orig
  FROM public.warehouse_transfer_lines WHERE id = p_original_transfer_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original_transfer_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- PROVENANCE: the original line must belong to a DIRECT forward transfer whose
  -- endpoints are exactly this return's corridor (central -> institution). This
  -- ties every returned batch to a real direct delivery, the guarantee the route
  -- gave the legacy path.
  SELECT * INTO v_transfer
  FROM public.warehouse_transfers WHERE id = v_orig.transfer_id;
  IF NOT FOUND
     OR v_transfer.route_id IS NOT NULL
     OR v_transfer.source_warehouse_id IS DISTINCT FROM v_request.destination_warehouse_id
     OR v_transfer.destination_warehouse_id IS DISTINCT FROM v_request.source_warehouse_id THEN
    RAISE EXCEPTION 'original_line_not_from_this_direct_corridor' USING ERRCODE = '42501';
  END IF;

  IF v_orig.resulting_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'original_line_not_received' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.warehouse_stock s
    WHERE s.id = v_orig.resulting_warehouse_stock_id
      AND s.organization_id = v_request.source_organization_id
      AND s.warehouse_id = v_request.source_warehouse_id
  ) THEN
    RAISE EXCEPTION 'original_line_not_at_this_institution' USING ERRCODE = '42501';
  END IF;

  v_remaining := COALESCE(v_orig.received_quantity, 0) - v_orig.returned_quantity;
  IF p_requested_quantity > v_remaining THEN
    RAISE EXCEPTION 'requested_quantity_exceeds_returnable' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.warehouse_return_request_lines (
    return_request_id, source_organization_id, original_transfer_line_id,
    scientific_name, concentration, dosage_form, unit,
    national_code, batch_number, internal_batch_reference, expiry_date,
    reason_code, reason_text, requested_quantity
  ) VALUES (
    v_request.id, v_request.source_organization_id, v_orig.id,
    v_orig.scientific_name, v_orig.concentration, v_orig.dosage_form, v_orig.unit,
    v_orig.national_code, v_orig.batch_number, v_orig.internal_batch_reference, v_orig.expiry_date,
    p_reason_code, NULLIF(btrim(p_reason_text), ''), p_requested_quantity
  )
  RETURNING id INTO v_line_id;

  RETURN jsonb_build_object('ok', true, 'return_request_line_id', v_line_id, 'direct', true);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_add_direct_warehouse_return_request_line(uuid, uuid, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_add_direct_warehouse_return_request_line(uuid, uuid, integer, text, text) TO authenticated;

-- 7e. Fail-closed guard on the LEGACY routed add-line: now that direct
-- (route_id NULL) return requests exist, the 069 routed add-line must refuse
-- them and point callers at the direct variant (its provenance-endpoint check
-- would otherwise be skipped). The routed path is preserved byte-for-byte.
CREATE OR REPLACE FUNCTION public.phoenix_add_warehouse_return_request_line(
  p_return_request_id         uuid,
  p_original_transfer_line_id uuid,
  p_requested_quantity        integer,
  p_reason_code                text,
  p_reason_text                 text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_request  public.warehouse_return_requests%ROWTYPE;
  v_orig     public.warehouse_transfer_lines%ROWTYPE;
  v_remaining integer;
  v_line_id  uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL OR p_original_transfer_line_id IS NULL THEN
    RAISE EXCEPTION 'request_and_original_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_requested_quantity IS NULL OR p_requested_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF p_reason_code IS NULL THEN
    RAISE EXCEPTION 'reason_code_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.warehouse_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- 077: a direct return must use phoenix_add_direct_warehouse_return_request_line.
  IF v_request.route_id IS NULL THEN
    RAISE EXCEPTION 'use_direct_add_line_for_direct_return' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_request',
    v_request.source_organization_id, v_request.source_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_request' USING ERRCODE = '42501';
  END IF;

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'return_request_not_draft' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_orig
  FROM public.warehouse_transfer_lines WHERE id = p_original_transfer_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original_transfer_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_orig.resulting_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'original_line_not_received' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.warehouse_stock s
    WHERE s.id = v_orig.resulting_warehouse_stock_id
      AND s.organization_id = v_request.source_organization_id
  ) THEN
    RAISE EXCEPTION 'original_line_not_at_this_institution' USING ERRCODE = '42501';
  END IF;

  v_remaining := COALESCE(v_orig.received_quantity, 0) - v_orig.returned_quantity;
  IF p_requested_quantity > v_remaining THEN
    RAISE EXCEPTION 'requested_quantity_exceeds_returnable' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.warehouse_return_request_lines (
    return_request_id, source_organization_id, original_transfer_line_id,
    scientific_name, concentration, dosage_form, unit,
    national_code, batch_number, internal_batch_reference, expiry_date,
    reason_code, reason_text, requested_quantity
  ) VALUES (
    v_request.id, v_request.source_organization_id, v_orig.id,
    v_orig.scientific_name, v_orig.concentration, v_orig.dosage_form, v_orig.unit,
    v_orig.national_code, v_orig.batch_number, v_orig.internal_batch_reference, v_orig.expiry_date,
    p_reason_code, NULLIF(btrim(p_reason_text), ''), p_requested_quantity
  )
  RETURNING id INTO v_line_id;

  RETURN jsonb_build_object('ok', true, 'return_request_line_id', v_line_id);
END;
$$;

-- 7f. SUBMIT — CREATE OR REPLACE'd so the route lookup runs ONLY for a legacy
-- routed request; a direct (route_id NULL) request never touches
-- warehouse_supply_routes. Every other line is 069 §9e byte-for-byte.
CREATE OR REPLACE FUNCTION public.phoenix_submit_warehouse_return_request(
  p_return_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_request    public.warehouse_return_requests%ROWTYPE;
  v_line_count integer;
  v_permission_key text;
  v_org        uuid;
  v_warehouse  uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL THEN
    RAISE EXCEPTION 'return_request_id_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_return_request_id::text, 69069));

  SELECT * INTO v_request
  FROM public.warehouse_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_request.requested_by_side = 'receiver' THEN
    v_permission_key := 'warehouse_transfer.return_request';
    v_org := v_request.source_organization_id;
    v_warehouse := v_request.source_warehouse_id;
  ELSE
    v_permission_key := 'warehouse_transfer.recall';
    v_org := v_request.destination_organization_id;
    v_warehouse := v_request.destination_warehouse_id;
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(v_actor, v_permission_key, v_org, v_warehouse, NULL) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_submit' USING ERRCODE = '42501';
  END IF;

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'return_request_not_draft' USING ERRCODE = '23514';
  END IF;

  IF v_request.route_id IS NOT NULL THEN
    -- Legacy routed: fix the route's identity for the transaction (FOR SHARE,
    -- not gated on is_active — see 069 §9e). Direct requests skip this entirely.
    PERFORM 1 FROM public.warehouse_supply_routes WHERE id = v_request.route_id FOR SHARE;
  ELSE
    -- Direct: re-assert the endpoints are still an active reverse corridor with
    -- real provenance, so a warehouse deactivated after draft cannot be submitted.
    PERFORM public.phoenix_assert_direct_return_endpoints(
      v_request.source_warehouse_id, v_request.destination_warehouse_id);
  END IF;

  SELECT count(*) INTO v_line_count
  FROM public.warehouse_return_request_lines WHERE return_request_id = v_request.id;
  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'return_request_has_no_lines' USING ERRCODE = '23514';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  UPDATE public.warehouse_return_requests
     SET status = 'submitted', requested_by = v_actor, requested_at = now()
   WHERE id = v_request.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_org, v_actor, v_actor_role,
    'warehouse_transfer.return_submitted', 'warehouse_return_requests', v_request.id,
    v_request.return_number, jsonb_build_object('line_count', v_line_count,
                                                'direct', v_request.route_id IS NULL)
  );

  RETURN jsonb_build_object('ok', true, 'return_request_id', v_request.id, 'status', 'submitted');
END;
$$;

-- 7g. DIRECT RETURN-SEND — stock leaves the institution warehouse, no route.
-- Mirrors phoenix_send_warehouse_return_shipment_line (069 §10) EXACTLY except
-- the endpoints come from the pinned DIRECT return request (route_id NULL)
-- instead of a route, and the shipment header is written with route_id NULL.
-- Same idempotency namespace (reference_type='warehouse_return_send'), same
-- deliberate absence of an expiry-refusal, same caps, ledger and audit rows.
CREATE OR REPLACE FUNCTION public.phoenix_send_direct_warehouse_return_shipment_line(
  p_request_id              uuid,   -- idempotency token for THIS send
  p_return_request_line_id  uuid,
  p_quantity                integer,
  p_shipment_number         text,
  p_document_number         text DEFAULT NULL,
  p_notes                   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_actor_name   text;
  v_reqline      public.warehouse_return_request_lines%ROWTYPE;
  v_request      public.warehouse_return_requests%ROWTYPE;
  v_orig         public.warehouse_transfer_lines%ROWTYPE;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_shipment     public.warehouse_return_shipments%ROWTYPE;
  v_existing     public.warehouse_stock_movements%ROWTYPE;
  v_number       text := NULLIF(btrim(p_shipment_number), '');
  v_doc          text := NULLIF(btrim(p_document_number), '');
  v_notes        text := NULLIF(btrim(p_notes), '');
  v_before       integer;
  v_after        integer;
  v_line_id      uuid;
  v_movement_id  uuid;
  v_fingerprint  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_return_request_line_id IS NULL THEN
    RAISE EXCEPTION 'request_and_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'shipment_number_required' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'direct_return_send',
    'return_request_line_id', p_return_request_line_id,
    'quantity', p_quantity,
    'shipment_number', v_number,
    'document_number', v_doc,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 69069));

  SELECT * INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'warehouse_return_send' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'warehouse_stock_id', v_existing.warehouse_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  -- The return request line, joined to a DIRECT (route_id NULL) request.
  SELECT l.* INTO v_reqline
  FROM public.warehouse_return_request_lines l
  JOIN public.warehouse_return_requests r ON r.id = l.return_request_id
  WHERE l.id = p_return_request_line_id AND r.route_id IS NULL
  FOR UPDATE OF l;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_line_not_found_for_direct' USING ERRCODE = 'P0002';
  END IF;
  IF v_reqline.status NOT IN ('approved', 'partially_fulfilled') THEN
    RAISE EXCEPTION 'return_request_line_not_approved' USING ERRCODE = '23514';
  END IF;
  IF v_reqline.fulfilled_quantity + p_quantity > v_reqline.approved_quantity THEN
    RAISE EXCEPTION 'return_line_would_be_over_fulfilled' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.warehouse_return_requests WHERE id = v_reqline.return_request_id FOR UPDATE;

  -- Endpoints still an active reverse corridor (re-asserted; both warehouse rows
  -- locked FOR SHARE against concurrent deactivation).
  PERFORM public.phoenix_assert_direct_return_endpoints(
    v_request.source_warehouse_id, v_request.destination_warehouse_id);

  SELECT * INTO v_orig
  FROM public.warehouse_transfer_lines WHERE id = v_reqline.original_transfer_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original_transfer_line_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_orig.returned_quantity + p_quantity > COALESCE(v_orig.received_quantity, 0) THEN
    RAISE EXCEPTION 'original_line_would_be_over_returned' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_stock
  FROM public.warehouse_stock WHERE id = v_orig.resulting_warehouse_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- The stock must sit in the return's SOURCE (institution) warehouse — the
  -- IDOR gate the route's target_warehouse_id gave the legacy path.
  IF v_stock.warehouse_id IS DISTINCT FROM v_request.source_warehouse_id THEN
    RAISE EXCEPTION 'stock_not_in_source_warehouse' USING ERRCODE = '42501';
  END IF;
  IF v_stock.organization_id IS DISTINCT FROM v_reqline.source_organization_id THEN
    RAISE EXCEPTION 'stock_organization_mismatch' USING ERRCODE = '42501';
  END IF;

  -- Authority: the actor's scoped assignment to the SOURCE (institution) warehouse.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_send', v_stock.organization_id, v_stock.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_send' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- Deliberately NO expiry-refusal here — a return is frequently OF an expired
  -- batch (069 §10).
  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;
  IF v_after < 0 THEN
    RAISE EXCEPTION 'warehouse_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  IF v_after < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'warehouse_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_shipment
  FROM public.warehouse_return_shipments
  WHERE source_organization_id = v_stock.organization_id
    AND btrim(shipment_number) = v_number
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.warehouse_return_shipments (
      route_id, return_request_id,
      source_warehouse_id, source_organization_id,
      destination_warehouse_id, destination_organization_id,
      shipment_number, status, document_number, notes, sent_by, sent_at
    ) VALUES (
      NULL, v_reqline.return_request_id,
      v_request.source_warehouse_id, v_stock.organization_id,
      v_request.destination_warehouse_id, v_request.destination_organization_id,
      v_number, 'in_transit', v_doc, v_notes, v_actor, now()
    )
    RETURNING * INTO v_shipment;
  ELSE
    -- An existing direct shipment must not be re-pointed at a routed shipment,
    -- nor at a different source/destination.
    IF v_shipment.route_id IS NOT NULL
       OR v_shipment.source_warehouse_id IS DISTINCT FROM v_request.source_warehouse_id
       OR v_shipment.destination_warehouse_id IS DISTINCT FROM v_request.destination_warehouse_id THEN
      RAISE EXCEPTION 'shipment_number_endpoint_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_shipment.status <> 'in_transit' THEN
      RAISE EXCEPTION 'shipment_already_being_received' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.warehouse_return_request_lines
     SET fulfilled_quantity = fulfilled_quantity + p_quantity,
         status = CASE WHEN fulfilled_quantity + p_quantity >= approved_quantity
                       THEN 'fulfilled' ELSE 'partially_fulfilled' END
   WHERE id = v_reqline.id;

  UPDATE public.warehouse_return_requests
     SET status = CASE WHEN NOT EXISTS (
                         SELECT 1 FROM public.warehouse_return_request_lines x
                         WHERE x.return_request_id = v_reqline.return_request_id
                           AND x.status NOT IN ('fulfilled', 'rejected', 'cancelled'))
                       THEN 'fulfilled' ELSE 'partially_fulfilled' END
   WHERE id = v_reqline.return_request_id;

  UPDATE public.warehouse_transfer_lines
     SET returned_quantity = returned_quantity + p_quantity
   WHERE id = v_orig.id;

  UPDATE public.warehouse_stock
     SET on_hand_quantity = v_after,
         updated_by       = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_return_shipment_lines (
    shipment_id, source_organization_id, source_warehouse_stock_id,
    return_request_line_id, original_transfer_line_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, unit_price, price_basis, currency, supply_type_text,
    sent_quantity, status
  ) VALUES (
    v_shipment.id, v_stock.organization_id, v_stock.id,
    v_reqline.id, v_orig.id, v_stock.central_item_id,
    v_stock.scientific_name, v_stock.trade_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.has_no_national_code,
    v_stock.batch_number, v_stock.has_no_batch_number, v_stock.internal_batch_reference,
    v_stock.expiry_date, v_stock.unit_price, v_stock.price_basis,
    v_stock.currency, v_stock.supply_type_text,
    p_quantity, 'in_transit'
  )
  RETURNING id INTO v_line_id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id, movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'dispatch_return',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'warehouse_transfer_return', 'warehouse_return_send', p_request_id, v_fingerprint,
    v_doc, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference
  )
  RETURNING id INTO v_movement_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_stock.organization_id, v_actor, v_actor_role,
    'warehouse_transfer.return_send', 'warehouse_return_shipment_lines', v_line_id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'direct', true,
      'return_request_id', v_request.id,
      'shipment_id', v_shipment.id,
      'source_warehouse_id', v_request.source_warehouse_id,
      'destination_warehouse_id', v_request.destination_warehouse_id,
      'movement_id', v_movement_id,
      'quantity_before', v_before,
      'quantity_delta', -p_quantity,
      'quantity_after', v_after
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'shipment_id', v_shipment.id,
    'shipment_line_id', v_line_id,
    'warehouse_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'in_transit_quantity', p_quantity,
    'quantity_before', v_before,
    'quantity_delta', -p_quantity,
    'quantity_after', v_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_send_direct_warehouse_return_shipment_line(uuid, uuid, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_send_direct_warehouse_return_shipment_line(uuid, uuid, integer, text, text, text) TO authenticated;

-- ============================================================================
-- POST-CONDITIONS — run on staging AFTER apply; every one must hold.
-- ============================================================================
-- NOTE: these are advisory checks to run manually after apply. They are wrapped
-- so a failure ABORTS the transaction (nothing is committed on a failed check).
DO $post$
BEGIN
  -- 1. route_id is now nullable on all four tables.
  IF (SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='warehouse_transfer_requests' AND column_name='route_id') <> 'YES'
     OR (SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='warehouse_transfers' AND column_name='route_id') <> 'YES' THEN
    RAISE EXCEPTION 'POSTCOND 077: route_id did not become nullable on the transfer tables.';
  END IF;

  -- 2. The legacy composite route FKs are STILL present (kept for routed rows).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wtr_route_endpoints_fk' AND contype='f')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wt_route_endpoints_fk' AND contype='f') THEN
    RAISE EXCEPTION 'POSTCOND 077: a legacy route FK was dropped — it must be retained.';
  END IF;

  -- 1b. route_id is now nullable on the two 069 RETURN tables too.
  IF (SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='warehouse_return_requests' AND column_name='route_id') <> 'YES'
     OR (SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='warehouse_return_shipments' AND column_name='route_id') <> 'YES' THEN
    RAISE EXCEPTION 'POSTCOND 077: route_id did not become nullable on the return tables.';
  END IF;

  -- 2b. The legacy RETURN composite route FKs are STILL present.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wrr_route_endpoints_fk' AND contype='f')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wrs_route_endpoints_fk' AND contype='f') THEN
    RAISE EXCEPTION 'POSTCOND 077: a legacy RETURN route FK was dropped — it must be retained.';
  END IF;

  -- 3. The new direct forward + return functions exist and are SECURITY DEFINER.
  IF to_regprocedure('public.phoenix_create_direct_warehouse_transfer_request(uuid,uuid,uuid,text,text)') IS NULL
     OR to_regprocedure('public.phoenix_send_direct_warehouse_transfer_line(uuid,uuid,uuid,integer,text,uuid,text,text)') IS NULL
     OR to_regprocedure('public.phoenix_assert_direct_return_endpoints(uuid,uuid)') IS NULL
     OR to_regprocedure('public.phoenix_request_direct_warehouse_return(uuid,uuid,text,text)') IS NULL
     OR to_regprocedure('public.phoenix_recall_direct_warehouse_transfer(uuid,uuid,text,text)') IS NULL
     OR to_regprocedure('public.phoenix_add_direct_warehouse_return_request_line(uuid,uuid,integer,text,text)') IS NULL
     OR to_regprocedure('public.phoenix_send_direct_warehouse_return_shipment_line(uuid,uuid,integer,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCOND 077: a direct-supply/return RPC is missing.';
  END IF;

  -- 4. The direct paths, the intelligence engine and the cross-org suggest path
  -- no longer read supply routes.
  IF pg_get_functiondef('public.phoenix_send_direct_warehouse_transfer_line(uuid,uuid,uuid,integer,text,uuid,text,text)'::regprocedure)
       LIKE '%warehouse_supply_routes%' THEN
    RAISE EXCEPTION 'POSTCOND 077: direct SEND still references warehouse_supply_routes.';
  END IF;
  IF pg_get_functiondef('public.phoenix_send_direct_warehouse_return_shipment_line(uuid,uuid,integer,text,text,text)'::regprocedure)
       LIKE '%warehouse_supply_routes%' THEN
    RAISE EXCEPTION 'POSTCOND 077: direct RETURN-SEND still references warehouse_supply_routes.';
  END IF;
  IF pg_get_functiondef('public.phoenix_request_direct_warehouse_return(uuid,uuid,text,text)'::regprocedure)
       LIKE '%warehouse_supply_routes%'
     OR pg_get_functiondef('public.phoenix_recall_direct_warehouse_transfer(uuid,uuid,text,text)'::regprocedure)
       LIKE '%warehouse_supply_routes%'
     OR pg_get_functiondef('public.phoenix_add_direct_warehouse_return_request_line(uuid,uuid,integer,text,text)'::regprocedure)
       LIKE '%warehouse_supply_routes%'
     OR pg_get_functiondef('public.phoenix_assert_direct_return_endpoints(uuid,uuid)'::regprocedure)
       LIKE '%warehouse_supply_routes%' THEN
    RAISE EXCEPTION 'POSTCOND 077: a direct RETURN build RPC still references warehouse_supply_routes.';
  END IF;
  IF pg_get_functiondef('public.phoenix_suggest_inventory_transfers(uuid)'::regprocedure)
       LIKE '%warehouse_supply_routes%' THEN
    RAISE EXCEPTION 'POSTCOND 077: suggest engine still references warehouse_supply_routes.';
  END IF;
  IF pg_get_functiondef('public.phoenix_inventory_suggestion_guard()'::regprocedure)
       LIKE '%warehouse_supply_routes%' THEN
    RAISE EXCEPTION 'POSTCOND 077: suggestion guard still references warehouse_supply_routes.';
  END IF;
  IF pg_get_functiondef('public.phoenix_suggest_cross_org_inventory_transfer(uuid,uuid,uuid,uuid,text,text)'::regprocedure)
       LIKE '%warehouse_supply_routes%' THEN
    RAISE EXCEPTION 'POSTCOND 077: cross-org suggest still references warehouse_supply_routes.';
  END IF;

  -- 4b. The direct RETURN reuses the (route-free) 069 RECEIVE unchanged.
  IF to_regprocedure('public.phoenix_receive_warehouse_return_shipment_line(uuid,uuid,integer,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCOND 077: the 069 return RECEIVE is missing (reused by the direct path).';
  END IF;

  -- 5. warehouse_supply_routes and its RPCs are UNTOUCHED (legacy compatibility).
  IF to_regclass('public.warehouse_supply_routes') IS NULL
     OR to_regprocedure('public.phoenix_create_supply_route(uuid,uuid,integer,text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCOND 077: legacy supply-route object was removed — must be retained until the later CONTRACT.';
  END IF;

  RAISE NOTICE 'POSTCOND 077: all structural post-conditions passed.';
END;
$post$;

commit;

-- ============================================================================
-- ROLLBACK (manual)
--   DROP FUNCTION IF EXISTS public.phoenix_send_direct_warehouse_return_shipment_line(uuid,uuid,integer,text,text,text);
--   DROP FUNCTION IF EXISTS public.phoenix_add_direct_warehouse_return_request_line(uuid,uuid,integer,text,text);
--   DROP FUNCTION IF EXISTS public.phoenix_recall_direct_warehouse_transfer(uuid,uuid,text,text);
--   DROP FUNCTION IF EXISTS public.phoenix_request_direct_warehouse_return(uuid,uuid,text,text);
--   DROP FUNCTION IF EXISTS public.phoenix_assert_direct_return_endpoints(uuid,uuid);
--   DROP FUNCTION IF EXISTS public.phoenix_send_direct_warehouse_transfer_line(uuid,uuid,uuid,integer,text,uuid,text,text);
--   DROP FUNCTION IF EXISTS public.phoenix_create_direct_warehouse_transfer_request(uuid,uuid,uuid,text,text);
--   DROP FUNCTION IF EXISTS public._phoenix_authorize_transfer_request_write(uuid, public.warehouse_transfer_requests);
--   DROP FUNCTION IF EXISTS public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid);
--   -- restore the 068/069/072 bodies from their original migrations (CREATE OR REPLACE:
--   -- phoenix_add_warehouse_return_request_line, phoenix_submit_warehouse_return_request,
--   -- phoenix_suggest_cross_org_inventory_transfer, and the 068 build/send bodies),
--   -- then: ALTER TABLE ... ALTER COLUMN route_id SET NOT NULL on all four tables (only
--   -- once no direct rows exist). DROP the partial indexes wtr_direct_idx / wt_direct_idx
--   -- / wrr_direct_idx / wrs_direct_idx.
-- ============================================================================
