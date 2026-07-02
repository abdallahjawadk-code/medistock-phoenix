-- =============================================================================
-- MediStock Phoenix V2 — Migration 041: Inter-Org Exchange RPCs
-- =============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard → SQL Editor after a verified backup, and
-- ONLY after migration 040 (inter_org_exchange_requests/events schema,
-- permission keys, role defaults, RLS) has already been manually applied.
--
-- Prerequisites: 001 (item_availability, organizations, distribution_points,
-- profiles), 002 (phoenix_my_role/phoenix_my_org), 010/017
-- (phoenix_profile_has_permission), 014 (actor-snapshot resolution pattern
-- this migration mirrors), 019/020 (item_availability material identity
-- columns: scientific_name/trade_name/dosage_form/concentration), 033/034
-- (item_availability_movements + phoenix_apply_availability_movement — the
-- row-lock + actor-snapshot + movement-insert pattern this migration reuses
-- for the completed transition), 036/037 (live alert computation + the
-- alert_key format this migration validates against), 038/039 (inter_org_
-- alert_states/events schema + RPCs — the closest structural precedent for
-- this migration's transition-RPC design), 040 (inter_org_exchange_requests/
-- events tables, 10 inter_org_exchange.* permission keys, role defaults, RLS
-- — REQUIRED, already manually applied by the owner).
--
-- Task: INTER-INSTITUTION-EXCHANGE-RPCS-C (designed in
-- INTER-INSTITUTION-EXCHANGE-WORKFLOW-AUDIT-A, schema built in
-- INTER-INSTITUTION-EXCHANGE-SCHEMA-B).
--
-- Purpose:
--   Migration 040 created the exchange schema with zero write access and a
--   SELECT-only, org-scoped, permission-gated read policy for
--   inter_org_exchange_requests, and zero direct access at all for
--   inter_org_exchange_events. This migration adds the four SECURITY DEFINER
--   RPCs that are the ONLY way to create/transition/read that schema:
--     1. phoenix_create_inter_org_exchange_request — creates a new exchange
--        request from a live alert, deriving every identity/org/quantity
--        fact from locked database rows, never from client input.
--     2. phoenix_update_inter_org_exchange_status — the sole transition RPC,
--        moving a request through requested -> source_approved/
--        source_rejected -> dispatched -> received -> completed, or
--        cancelled before dispatch. The received -> completed transition is
--        the ONLY place any stock quantity is ever touched by this
--        migration, and it does so atomically (lock both availability rows,
--        verify sufficiency, subtract/add, insert two movement ledger rows,
--        stamp the request with both movement ids) in the same transaction
--        as the status flip.
--     3. phoenix_get_inter_org_exchange_events — the sole controlled read
--        path for inter_org_exchange_events (zero direct grants/policies per
--        migration 040's explicit decision).
--     4. phoenix_get_inter_org_exchange_requests — an org-scoped, paginated
--        listing RPC (the direct-SELECT policy from migration 040 already
--        allows raw reads, but this RPC gives the frontend a single safe
--        entry point with status filtering and bounded pagination, matching
--        the read-RPC convention already established by
--        phoenix_get_live_inter_institution_alerts).
--
-- What this migration does NOT do:
--   - Does NOT modify migrations 001-040 in any way.
--   - Does NOT create any new table, permission key, role default, or RLS
--     policy — all ten inter_org_exchange.* permission keys and both tables
--     already exist as of migration 040.
--   - Does NOT create a direct SELECT/INSERT/UPDATE/DELETE policy on
--     inter_org_exchange_events — it remains readable ONLY through
--     phoenix_get_inter_org_exchange_events (SECURITY DEFINER bypasses RLS
--     internally, the same sanctioned path as inter_org_alert_events/
--     migration 039).
--   - Does NOT create any INSERT/UPDATE/DELETE policy on
--     inter_org_exchange_requests — all writes happen exclusively inside the
--     SECURITY DEFINER functions below; the existing SELECT-only policy from
--     migration 040 is untouched.
--   - Does NOT touch get_public_qr_payload, qr_tokens, qr_targets, or any
--     other QR-related object.
--   - Does NOT touch phoenix_update_inter_org_alert_state, phoenix_reopen_
--     inter_org_alert, or phoenix_get_inter_org_alert_events (038/039).
--   - Does NOT call phoenix_apply_availability_movement. That RPC is gated
--     by the separate availability.quantity.{set,add,subtract,correct}
--     permission family, which an exchange approver/receiver is not expected
--     to hold — the whole point of the inter_org_exchange.* permission
--     namespace (migration 040) is that exchange authority is independent of
--     direct quantity-edit authority. Calling it internally would either
--     silently require the actor to also hold an unrelated permission, or
--     require this migration to bypass phoenix_apply_availability_movement's
--     own permission checks in a way that would be far more fragile than
--     just reusing its exact, already-audited row-lock/update/insert pattern
--     directly (see the completed-transition design decision below).
--   - Does NOT invent a new item_availability_movements.movement_type value.
--     Migration 033's CHECK constraint only allows ('set_exact', 'add',
--     'subtract', 'correction'); this migration does not ALTER that
--     constraint (which would mean touching a table only migration 033
--     "owns" the definition of, and the task explicitly says to STOP and
--     report rather than invent an unsafe new type). Instead, the completed
--     transition below reuses the existing, already-safe 'subtract' and
--     'add' movement types verbatim — 'subtract' at the source row and 'add'
--     at the target row are semantically exact matches for "quantity left
--     here" / "quantity arrived here", so no schema change is needed or
--     made. See the RPC 2 header comment for full detail.
--   - Does NOT wire any frontend screen to these RPCs — no UI changes at all
--     in this migration.
--   - Does NOT add WhatsApp or Google Drive integration.
--   - Does NOT use service_role or any elevated/admin API key.
--   - Does NOT add Excel/XLSX import.
--   - Does NOT expose supply_type anywhere.
--
-- Actor snapshot columns (confirmed against migration 001/014/034, not
-- assumed): profiles has full_name (text, not null) and role (text, not
-- null) but NO email column — email lives on auth.users only. This
-- migration resolves the actor identity snapshot exactly like
-- phoenix_apply_availability_movement (034) / phoenix_update_inter_org_
-- alert_state (039):
--   SELECT p.full_name, u.email, p.role
--     FROM public.profiles p LEFT JOIN auth.users u ON u.id = p.id
--    WHERE p.id = <actor>
--   (LEFT JOIN because auth.users is only readable with SECURITY DEFINER
--   privilege, same documented reason as 034/039.)
--
-- Error-reporting convention (matches migration 039's established split):
--   - RPC 3 (read: events) and RPC 4 (read: requests list) return
--     { ok: false, error: '...' } jsonb, mirroring phoenix_get_live_inter_
--     institution_alerts / phoenix_get_inter_org_alert_events — the
--     established convention for read-oriented RPCs.
--   - RPC 1 (create) and RPC 2 (transition) RAISE EXCEPTION with a specific
--     ERRCODE per failure, mirroring phoenix_apply_availability_movement
--     (034) and phoenix_update_inter_org_alert_state (039) exactly — the
--     established convention for write/transition RPCs. Both styles are
--     intentional, matching the two families of RPC that already coexist in
--     this schema.
--
-- Row-lock ordering (deadlock avoidance): whenever this migration locks two
-- item_availability rows in the same transaction (RPC 1's read, RPC 2's
-- completed-transition write), it locks them via a single
-- `SELECT ... WHERE id IN (a, b) ORDER BY id FOR UPDATE` query rather than
-- two separate `SELECT ... FOR UPDATE` statements. Postgres acquires FOR
-- UPDATE row locks in the order rows are produced, so ordering by id
-- guarantees every caller (this RPC, any future concurrent caller) always
-- attempts to lock the same two rows in the same relative order, making a
-- circular-wait deadlock between two concurrent exchange operations on the
-- same pair of rows impossible.
--
-- alert_key integrity check: RPC 1 does not trust p_source_item_
-- availability_id/p_target_item_availability_id in isolation — it parses
-- p_alert_key (source_id::text || ':' || target_id::text || ':' ||
-- alert_type, the exact format from migrations 037/038/039/040) and asserts
-- the first two colon-delimited segments equal the two id parameters,
-- rejecting any mismatch. This directly enforces the audit's stated
-- principle "source and target item availability IDs must match the alert
-- payload."
--
-- source_rejected actor column reuse: inter_org_exchange_requests
-- (migration 040) has requested_by/approved_by/dispatched_by/received_by/
-- cancelled_by — there is no dedicated rejected_by column. The
-- source_rejected transition reuses approved_by/approved_at (the same
-- source-org actor who would otherwise have approved is the one recording
-- the rejection decision instead — both are the outcome of the same
-- "source organization reviewed the request" action). approved_quantity is
-- left NULL on rejection (migration 040's CHECK only requires it once status
-- reaches source_approved/dispatched/received/completed, not
-- source_rejected).
--
-- Security: SECURITY DEFINER, SET search_path = public on all four
-- functions (matching 034/039 exactly — not "public, pg_temp", which is
-- phoenix_profile_has_permission's own, different, precedent). REVOKE ALL
-- FROM PUBLIC, anon; GRANT EXECUTE TO authenticated only. No new direct
-- table grant or policy on either exchange table.
-- =============================================================================

-- =============================================================================
-- RPC 1: phoenix_create_inter_org_exchange_request
-- =============================================================================
-- Creates a new exchange request from a live alert. Every identity fact
-- (organizations, distribution points, material snapshot, trade names) is
-- read from the locked source/target item_availability rows — none of it is
-- trusted from client input beyond the two availability ids themselves,
-- which are in turn cross-checked against the supplied alert_key.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_create_inter_org_exchange_request(
  p_alert_key                    text,
  p_alert_state_id                uuid DEFAULT NULL,
  p_source_item_availability_id   uuid DEFAULT NULL,
  p_target_item_availability_id   uuid DEFAULT NULL,
  p_requested_quantity            integer DEFAULT NULL,
  p_reason                        text DEFAULT NULL,
  p_notes                         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_role         text;
  v_my_org       uuid;
  v_is_super     boolean;
  v_can_request  boolean;
  v_key_parts    text[];
  v_source       public.item_availability%ROWTYPE;
  v_target       public.item_availability%ROWTYPE;
  v_row          record;
  v_alert_state  public.inter_org_alert_states%ROWTYPE;
  v_actor_name   text;
  v_actor_email  text;
  v_actor_role   text;
  v_request_id   uuid;
  v_now          timestamptz := now();
BEGIN
  -- 1. Auth required.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- 2. Basic input validation.
  IF p_alert_key IS NULL OR btrim(p_alert_key) = '' THEN
    RAISE EXCEPTION 'alert_key_required' USING ERRCODE = '23514';
  END IF;

  IF p_source_item_availability_id IS NULL OR p_target_item_availability_id IS NULL THEN
    RAISE EXCEPTION 'availability_ids_required' USING ERRCODE = '23514';
  END IF;

  IF p_source_item_availability_id = p_target_item_availability_id THEN
    RAISE EXCEPTION 'availability_must_differ' USING ERRCODE = '23514';
  END IF;

  IF p_requested_quantity IS NULL OR p_requested_quantity <= 0 THEN
    RAISE EXCEPTION 'requested_quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;

  -- 3. alert_key integrity: the first two colon-delimited segments must
  --    equal the two availability id parameters, exactly the format used by
  --    migrations 037/038/039/040 (source_id::text || ':' || target_id::text
  --    || ':' || alert_type). Prevents a client from pairing a real
  --    alert_key with mismatched availability ids.
  v_key_parts := string_to_array(p_alert_key, ':');
  IF array_length(v_key_parts, 1) < 3
     OR v_key_parts[1] <> p_source_item_availability_id::text
     OR v_key_parts[2] <> p_target_item_availability_id::text THEN
    RAISE EXCEPTION 'alert_key_mismatch' USING ERRCODE = '23514';
  END IF;

  -- 4. Lock source and target item_availability rows together, ordered by
  --    id, to avoid deadlocking against a concurrent call locking the same
  --    pair in the opposite order (see migration header).
  FOR v_row IN
    SELECT * FROM public.item_availability
    WHERE id IN (p_source_item_availability_id, p_target_item_availability_id)
    ORDER BY id
    FOR UPDATE
  LOOP
    IF v_row.id = p_source_item_availability_id THEN
      v_source := v_row;
    ELSE
      v_target := v_row;
    END IF;
  END LOOP;

  IF v_source.id IS NULL OR v_target.id IS NULL THEN
    RAISE EXCEPTION 'availability_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- 5. Data integrity: source and target must belong to different
  --    organizations (mirrors inter_org_exchange_requests_orgs_distinct_chk,
  --    migration 040 — checked here first for a clearer error message).
  IF v_source.organization_id = v_target.organization_id THEN
    RAISE EXCEPTION 'organizations_must_differ' USING ERRCODE = '23514';
  END IF;

  -- 6. Authorize: the requester must belong to the TARGET (requesting/
  --    needing) organization and hold inter_org_exchange.request, OR hold
  --    inter_org_exchange.manage (which bypasses the org-membership
  --    requirement — an admin-override key), OR be super_admin.
  v_role     := phoenix_my_role();
  v_my_org   := phoenix_my_org();
  v_is_super := (v_role = 'super_admin');

  v_can_request := v_is_super
    OR phoenix_profile_has_permission(v_actor, 'inter_org_exchange.manage')
    OR (v_my_org = v_target.organization_id AND phoenix_profile_has_permission(v_actor, 'inter_org_exchange.request'));

  IF NOT v_can_request THEN
    RAISE EXCEPTION 'forbidden_inter_org_exchange_request' USING ERRCODE = '42501';
  END IF;

  -- 7. Best-effort link to the persisted alert lifecycle row (migration
  --    038). p_alert_state_id is accepted for signature compatibility but
  --    is NOT trusted directly — the authoritative alert_state_id is always
  --    re-resolved here from alert_key, never taken from client input,
  --    preventing a client from linking this request to an unrelated
  --    alert's state row. A missing/absent alert state row is not an error
  --    (alert_state_id is nullable) — the alert may have been recomputed
  --    away or never persisted.
  SELECT * INTO v_alert_state
  FROM public.inter_org_alert_states
  WHERE alert_key = p_alert_key;

  -- 8. Resolve actor identity snapshot (not stored on the request row
  --    itself, but resolved here for the 'requested' event below — mirrors
  --    034/039's exact resolution logic).
  SELECT p.full_name, u.email, p.role
    INTO v_actor_name, v_actor_email, v_actor_role
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.id = v_actor;

  -- 9. Insert the request. Every identity/org/point/material field is read
  --    from the locked v_source/v_target rows, never from client input.
  --    Duplicate-active-request protection is the partial unique index
  --    inter_org_exchange_requests_active_alert_key_uq (migration 040) —
  --    caught below and converted into a clear, named error.
  BEGIN
    INSERT INTO public.inter_org_exchange_requests (
      alert_key, alert_state_id,
      source_item_availability_id, target_item_availability_id,
      source_organization_id, target_organization_id,
      source_distribution_point_id, target_distribution_point_id,
      scientific_name, concentration, dosage_form,
      source_trade_name, target_trade_name,
      requested_quantity, status, severity_snapshot,
      reason, notes,
      requested_by, requested_at
    ) VALUES (
      p_alert_key, v_alert_state.id,
      v_source.id, v_target.id,
      v_source.organization_id, v_target.organization_id,
      v_source.distribution_point_id, v_target.distribution_point_id,
      v_source.scientific_name, v_source.concentration, v_source.dosage_form,
      v_source.trade_name, v_target.trade_name,
      p_requested_quantity, 'requested', v_alert_state.severity_snapshot,
      p_reason, p_notes,
      v_actor, v_now
    )
    RETURNING id INTO v_request_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'duplicate_active_exchange_request' USING ERRCODE = '23505';
  END;

  -- 10. Append the immutable 'requested' event.
  INSERT INTO public.inter_org_exchange_events (
    exchange_request_id, event_type, actor_id, actor_org_id,
    actor_name_snapshot, actor_email_snapshot, actor_role_snapshot,
    from_status, to_status, quantity_snapshot, reason, notes
  ) VALUES (
    v_request_id, 'requested', v_actor, v_my_org,
    v_actor_name, v_actor_email, v_actor_role,
    NULL, 'requested',
    jsonb_build_object('requested', p_requested_quantity),
    p_reason, p_notes
  );

  RETURN jsonb_build_object(
    'ok', true,
    'exchange_request_id', v_request_id,
    'alert_key', p_alert_key,
    'status', 'requested',
    'requested_quantity', p_requested_quantity,
    'source_organization_id', v_source.organization_id,
    'target_organization_id', v_target.organization_id,
    'requested_at', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_create_inter_org_exchange_request(
  text, uuid, uuid, uuid, integer, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_create_inter_org_exchange_request(
  text, uuid, uuid, uuid, integer, text, text
) TO authenticated;

-- =============================================================================
-- RPC 2: phoenix_update_inter_org_exchange_status
-- =============================================================================
-- The sole transition RPC. Allowed transitions:
--   requested       -> source_approved  (source org, inter_org_exchange.approve)
--   requested       -> source_rejected  (source org, inter_org_exchange.approve)
--   requested       -> cancelled        (target org, inter_org_exchange.cancel)
--   source_approved -> dispatched       (source org, inter_org_exchange.dispatch)
--   source_approved -> cancelled        (target org, inter_org_exchange.cancel)
--   dispatched      -> received         (target org, inter_org_exchange.receive)
--   received        -> completed        (target org, inter_org_exchange.receive)
-- source_rejected/cancelled/completed are terminal — no further transition
-- is ever allowed once a request reaches one of them.
--
-- Movement safety: NO stock quantity is touched by requested,
-- source_approved, source_rejected, dispatched, received, or cancelled — the
-- "dispatched -> received" transition only records who/when the target
-- confirmed physical receipt and how much (p_received_quantity), exactly
-- like inter_org_alert_states records human coordination state without
-- touching stock. The ONLY transition that ever writes to
-- item_availability.quantity or item_availability_movements is
-- "received -> completed": it locks both availability rows (ordered by id,
-- same deadlock-avoidance pattern as RPC 1), re-verifies the source has
-- enough quantity at the moment of completion (not just at approval time),
-- subtracts the already-recorded received_quantity from source, adds it to
-- target, and inserts one 'subtract' movement row at the source and one
-- 'add' movement row at the target (both existing, already-safe movement
-- types from migration 033 — see the migration header for why no new type
-- is invented). Both movement ids are then stamped onto the request row
-- (movement_id_out/movement_id_in), satisfying migration 040's
-- inter_org_exchange_requests_completed_movement_ids_chk CHECK constraint.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_update_inter_org_exchange_status(
  p_exchange_request_id  uuid,
  p_next_status          text,
  p_approved_quantity    integer DEFAULT NULL,
  p_received_quantity    integer DEFAULT NULL,
  p_reason               text DEFAULT NULL,
  p_notes                text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor         uuid := auth.uid();
  v_role          text;
  v_my_org        uuid;
  v_is_super      boolean;
  v_row           public.inter_org_exchange_requests%ROWTYPE;
  v_allowed       boolean;
  v_authorized    boolean;
  v_actor_name    text;
  v_actor_email   text;
  v_actor_role    text;
  v_now           timestamptz := now();
  v_avail_row     record;
  v_source_avail  public.item_availability%ROWTYPE;
  v_target_avail  public.item_availability%ROWTYPE;
  v_movement_out  uuid;
  v_movement_in   uuid;
BEGIN
  -- 1. Auth required.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- 2. Basic input validation.
  IF p_exchange_request_id IS NULL THEN
    RAISE EXCEPTION 'exchange_request_id_required' USING ERRCODE = '23514';
  END IF;

  IF p_next_status IS NULL OR p_next_status NOT IN (
    'requested', 'source_approved', 'source_rejected',
    'dispatched', 'received', 'completed', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'invalid_target_status' USING ERRCODE = '23514';
  END IF;

  -- 3. Lock the target row before any authorization/transition check
  --    (prevents concurrent-transition races on the same request).
  SELECT * INTO v_row
  FROM public.inter_org_exchange_requests
  WHERE id = p_exchange_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- 4. Terminal statuses can never transition further.
  IF v_row.status IN ('source_rejected', 'cancelled', 'completed') THEN
    RAISE EXCEPTION 'exchange_request_terminal' USING ERRCODE = '23514';
  END IF;

  -- 5. Validate the transition itself (status read from the LOCKED row).
  v_allowed :=
       (v_row.status = 'requested'        AND p_next_status = 'source_approved')
    OR (v_row.status = 'requested'        AND p_next_status = 'source_rejected')
    OR (v_row.status = 'requested'        AND p_next_status = 'cancelled')
    OR (v_row.status = 'source_approved'  AND p_next_status = 'dispatched')
    OR (v_row.status = 'source_approved'  AND p_next_status = 'cancelled')
    OR (v_row.status = 'dispatched'       AND p_next_status = 'received')
    OR (v_row.status = 'received'         AND p_next_status = 'completed');

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '23514';
  END IF;

  -- 6. Reason requirement: source_rejected and cancelled both require a
  --    non-empty reason — mirrors migration 040's
  --    inter_org_exchange_requests_rejected_reason_chk /
  --    _cancelled_reason_chk CHECK constraints (this check gives a clearer
  --    error earlier than letting the UPDATE fail on the constraint).
  IF p_next_status IN ('source_rejected', 'cancelled') AND (p_reason IS NULL OR btrim(p_reason) = '') THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '23514';
  END IF;

  -- 7. Authorize: org scope + permission per target status. Org ids are
  --    read from the LOCKED row, never trusted from client input.
  --    super_admin bypasses the organization boundary (per the audit's
  --    design principle) but never bypasses the quantity/data-integrity
  --    checks below.
  v_role     := phoenix_my_role();
  v_my_org   := phoenix_my_org();
  v_is_super := (v_role = 'super_admin');

  IF p_next_status IN ('source_approved', 'source_rejected') THEN
    v_authorized := v_is_super
      OR phoenix_profile_has_permission(v_actor, 'inter_org_exchange.manage')
      OR (v_my_org = v_row.source_organization_id AND phoenix_profile_has_permission(v_actor, 'inter_org_exchange.approve'));
  ELSIF p_next_status = 'dispatched' THEN
    v_authorized := v_is_super
      OR phoenix_profile_has_permission(v_actor, 'inter_org_exchange.manage')
      OR (v_my_org = v_row.source_organization_id AND phoenix_profile_has_permission(v_actor, 'inter_org_exchange.dispatch'));
  ELSIF p_next_status IN ('received', 'completed') THEN
    v_authorized := v_is_super
      OR phoenix_profile_has_permission(v_actor, 'inter_org_exchange.manage')
      OR (v_my_org = v_row.target_organization_id AND phoenix_profile_has_permission(v_actor, 'inter_org_exchange.receive'));
  ELSIF p_next_status = 'cancelled' THEN
    -- Target/requesting organization only, and only before dispatch (the
    -- transition whitelist above already restricts cancelled to being
    -- reachable only from requested/source_approved, i.e. always "before
    -- dispatch" by construction).
    v_authorized := v_is_super
      OR phoenix_profile_has_permission(v_actor, 'inter_org_exchange.manage')
      OR (v_my_org = v_row.target_organization_id AND phoenix_profile_has_permission(v_actor, 'inter_org_exchange.cancel'));
  ELSE
    v_authorized := false;
  END IF;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'forbidden_inter_org_exchange_transition' USING ERRCODE = '42501';
  END IF;

  -- 8. Quantity validation per transition. Never trust frontend checks —
  --    every bound is re-verified here against the LOCKED row.
  IF p_next_status = 'source_approved' THEN
    IF p_approved_quantity IS NULL OR p_approved_quantity <= 0 THEN
      RAISE EXCEPTION 'approved_quantity_must_be_positive' USING ERRCODE = '23514';
    END IF;
    IF p_approved_quantity > v_row.requested_quantity THEN
      RAISE EXCEPTION 'approved_quantity_exceeds_requested' USING ERRCODE = '23514';
    END IF;
  ELSIF p_next_status = 'received' THEN
    IF p_received_quantity IS NULL OR p_received_quantity <= 0 THEN
      RAISE EXCEPTION 'received_quantity_must_be_positive' USING ERRCODE = '23514';
    END IF;
    IF v_row.approved_quantity IS NULL OR p_received_quantity > v_row.approved_quantity THEN
      RAISE EXCEPTION 'received_quantity_exceeds_approved' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- 9. Resolve actor identity snapshot for the event row below.
  SELECT p.full_name, u.email, p.role
    INTO v_actor_name, v_actor_email, v_actor_role
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.id = v_actor;

  -- 10. Apply the transition. "completed" performs the atomic stock
  --     movement (the only branch that ever touches item_availability or
  --     item_availability_movements); every other branch only updates
  --     inter_org_exchange_requests' own status/actor/timestamp/quantity
  --     columns.
  IF p_next_status = 'completed' THEN
    -- Lock source and target availability rows together, ordered by id
    -- (same deadlock-avoidance pattern as RPC 1).
    FOR v_avail_row IN
      SELECT * FROM public.item_availability
      WHERE id IN (v_row.source_item_availability_id, v_row.target_item_availability_id)
      ORDER BY id
      FOR UPDATE
    LOOP
      IF v_avail_row.id = v_row.source_item_availability_id THEN
        v_source_avail := v_avail_row;
      ELSE
        v_target_avail := v_avail_row;
      END IF;
    END LOOP;

    IF v_source_avail.id IS NULL OR v_target_avail.id IS NULL THEN
      RAISE EXCEPTION 'availability_not_found' USING ERRCODE = 'P0002';
    END IF;

    -- Re-verify sufficiency at the moment of completion — stock may have
    -- moved since approval. Raising here rolls back the whole transaction:
    -- no item_availability UPDATE and no movement INSERT happen, and the
    -- request row stays at 'received' (safe to retry once stock is
    -- replenished).
    IF v_source_avail.quantity < v_row.received_quantity THEN
      RAISE EXCEPTION 'source_quantity_insufficient' USING ERRCODE = '23514';
    END IF;

    -- Atomic write: subtract from source, add to target, one movement row
    -- each (reusing the existing, already-safe 'subtract'/'add' types —
    -- see migration header for why no new movement_type is invented),
    -- then stamp both movement ids + completed_at + status onto the
    -- locked request row.
    UPDATE public.item_availability
       SET quantity = quantity - v_row.received_quantity,
           last_updated_by = v_actor
     WHERE id = v_source_avail.id;

    UPDATE public.item_availability
       SET quantity = quantity + v_row.received_quantity,
           last_updated_by = v_actor
     WHERE id = v_target_avail.id;

    INSERT INTO public.item_availability_movements (
      item_availability_id, organization_id, distribution_point_id,
      scientific_name, concentration, dosage_form, trade_name,
      movement_type, quantity_before, quantity_delta, quantity_after,
      reason, notes, created_by,
      actor_name_snapshot, actor_email_snapshot, actor_role_snapshot
    ) VALUES (
      v_source_avail.id, v_source_avail.organization_id, v_source_avail.distribution_point_id,
      v_source_avail.scientific_name, v_source_avail.concentration, v_source_avail.dosage_form, v_source_avail.trade_name,
      'subtract', v_source_avail.quantity, -v_row.received_quantity, v_source_avail.quantity - v_row.received_quantity,
      coalesce(p_reason, 'Inter-org exchange transfer'),
      'inter_org_exchange_request_id=' || v_row.id::text || coalesce(' | ' || p_notes, ''),
      v_actor, v_actor_name, v_actor_email, v_actor_role
    )
    RETURNING id INTO v_movement_out;

    INSERT INTO public.item_availability_movements (
      item_availability_id, organization_id, distribution_point_id,
      scientific_name, concentration, dosage_form, trade_name,
      movement_type, quantity_before, quantity_delta, quantity_after,
      reason, notes, created_by,
      actor_name_snapshot, actor_email_snapshot, actor_role_snapshot
    ) VALUES (
      v_target_avail.id, v_target_avail.organization_id, v_target_avail.distribution_point_id,
      v_target_avail.scientific_name, v_target_avail.concentration, v_target_avail.dosage_form, v_target_avail.trade_name,
      'add', v_target_avail.quantity, v_row.received_quantity, v_target_avail.quantity + v_row.received_quantity,
      coalesce(p_reason, 'Inter-org exchange transfer'),
      'inter_org_exchange_request_id=' || v_row.id::text || coalesce(' | ' || p_notes, ''),
      v_actor, v_actor_name, v_actor_email, v_actor_role
    )
    RETURNING id INTO v_movement_in;

    UPDATE public.inter_org_exchange_requests
       SET status         = 'completed',
           movement_id_out = v_movement_out,
           movement_id_in  = v_movement_in,
           completed_at    = v_now,
           reason          = coalesce(p_reason, reason),
           notes           = coalesce(p_notes, notes),
           updated_at      = v_now
     WHERE id = v_row.id;
  ELSE
    UPDATE public.inter_org_exchange_requests
       SET status = p_next_status,
           approved_quantity = CASE WHEN p_next_status = 'source_approved' THEN p_approved_quantity ELSE approved_quantity END,
           received_quantity = CASE WHEN p_next_status = 'received' THEN p_received_quantity ELSE received_quantity END,
           -- source_approved/source_rejected share approved_by/approved_at
           -- (see migration header for why there is no dedicated
           -- rejected_by column).
           approved_by   = CASE WHEN p_next_status IN ('source_approved', 'source_rejected') THEN v_actor ELSE approved_by END,
           approved_at   = CASE WHEN p_next_status IN ('source_approved', 'source_rejected') THEN v_now ELSE approved_at END,
           dispatched_by = CASE WHEN p_next_status = 'dispatched' THEN v_actor ELSE dispatched_by END,
           dispatched_at = CASE WHEN p_next_status = 'dispatched' THEN v_now ELSE dispatched_at END,
           received_by   = CASE WHEN p_next_status = 'received' THEN v_actor ELSE received_by END,
           received_at   = CASE WHEN p_next_status = 'received' THEN v_now ELSE received_at END,
           cancelled_by  = CASE WHEN p_next_status = 'cancelled' THEN v_actor ELSE cancelled_by END,
           cancelled_at  = CASE WHEN p_next_status = 'cancelled' THEN v_now ELSE cancelled_at END,
           reason     = p_reason,
           notes      = p_notes,
           updated_at = v_now
     WHERE id = v_row.id;
  END IF;

  -- 11. Append one immutable event for this transition.
  INSERT INTO public.inter_org_exchange_events (
    exchange_request_id, event_type, actor_id, actor_org_id,
    actor_name_snapshot, actor_email_snapshot, actor_role_snapshot,
    from_status, to_status, quantity_snapshot, reason, notes
  ) VALUES (
    v_row.id, p_next_status, v_actor, v_my_org,
    v_actor_name, v_actor_email, v_actor_role,
    v_row.status, p_next_status,
    jsonb_build_object(
      'requested', v_row.requested_quantity,
      'approved', CASE WHEN p_next_status = 'source_approved' THEN p_approved_quantity ELSE v_row.approved_quantity END,
      'received', CASE WHEN p_next_status = 'received' THEN p_received_quantity ELSE v_row.received_quantity END
    ),
    p_reason, p_notes
  );

  RETURN jsonb_build_object(
    'ok', true,
    'exchange_request_id', v_row.id,
    'from_status', v_row.status,
    'to_status', p_next_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_update_inter_org_exchange_status(
  uuid, text, integer, integer, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_update_inter_org_exchange_status(
  uuid, text, integer, integer, text, text
) TO authenticated;

-- =============================================================================
-- RPC 3: phoenix_get_inter_org_exchange_events
-- =============================================================================
-- The sole controlled read path for inter_org_exchange_events, which (per
-- migration 040's explicit direct-SELECT decision, mirroring
-- inter_org_alert_events) has zero direct table grants/policies for any
-- client role. Returns event history ordered OLDEST-first (created_at ASC —
-- a chronological timeline, unlike phoenix_get_inter_org_alert_events'
-- newest-first convention), projecting out actor_id and exchange_request_id
-- (no internal ids returned — only the display-oriented actor snapshot +
-- transition fields, same projection style as 039's event RPC).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_get_inter_org_exchange_events(
  p_exchange_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_role     text;
  v_org      uuid;
  v_is_super boolean;
  v_can_view boolean;
  v_request  public.inter_org_exchange_requests%ROWTYPE;
  v_events   jsonb;
BEGIN
  -- 1. Auth required.
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT role, organization_id INTO v_role, v_org
  FROM public.profiles WHERE id = v_actor;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ACTOR_PROFILE_NOT_FOUND');
  END IF;

  v_is_super := (v_role = 'super_admin');

  IF p_exchange_request_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'EXCHANGE_REQUEST_ID_REQUIRED');
  END IF;

  -- 2. Fetch the parent request row to determine org scope.
  SELECT * INTO v_request
  FROM public.inter_org_exchange_requests
  WHERE id = p_exchange_request_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'EXCHANGE_REQUEST_NOT_FOUND');
  END IF;

  -- 3. Org scope: super_admin sees all; otherwise actor org must be the
  --    source or target org of this specific request.
  IF NOT v_is_super
     AND v_request.source_organization_id <> v_org
     AND v_request.target_organization_id <> v_org THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;

  -- 4. Permission gate (in addition to org scope above).
  v_can_view := v_is_super
    OR phoenix_profile_has_permission(v_actor, 'inter_org_exchange.events.view')
    OR phoenix_profile_has_permission(v_actor, 'inter_org_exchange.view')
    OR phoenix_profile_has_permission(v_actor, 'inter_org_exchange.manage');

  IF NOT v_can_view THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;

  -- 5. Read events oldest-first (no direct table grant exists — this
  --    SECURITY DEFINER function bypasses RLS/grants internally, the only
  --    sanctioned path).
  SELECT jsonb_agg(
    jsonb_build_object(
      'event_type', e.event_type,
      'actor_org_id', e.actor_org_id,
      'actor_name_snapshot', e.actor_name_snapshot,
      'actor_email_snapshot', e.actor_email_snapshot,
      'actor_role_snapshot', e.actor_role_snapshot,
      'from_status', e.from_status,
      'to_status', e.to_status,
      'quantity_snapshot', e.quantity_snapshot,
      'reason', e.reason,
      'notes', e.notes,
      'created_at', e.created_at
    )
    ORDER BY e.created_at ASC
  )
  INTO v_events
  FROM public.inter_org_exchange_events e
  WHERE e.exchange_request_id = v_request.id;

  RETURN jsonb_build_object(
    'ok', true,
    'exchange_request_id', p_exchange_request_id,
    'events', coalesce(v_events, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_get_inter_org_exchange_events(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_inter_org_exchange_events(uuid)
  TO authenticated;

-- =============================================================================
-- RPC 4: phoenix_get_inter_org_exchange_requests
-- =============================================================================
-- Org-scoped, paginated listing of exchange requests. Migration 040's own
-- SELECT policy on inter_org_exchange_requests already allows direct reads
-- with the same org-scope/permission rule enforced here; this RPC exists to
-- give the frontend one safe, bounded entry point with optional status
-- filtering, matching the read-RPC convention already established by
-- phoenix_get_live_inter_institution_alerts (036/037).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_get_inter_org_exchange_requests(
  p_status text DEFAULT NULL,
  p_limit  integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_role     text;
  v_org      uuid;
  v_is_super boolean;
  v_can_view boolean;
  v_limit    integer;
  v_offset   integer;
  v_requests jsonb;
BEGIN
  -- 1. Auth required.
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT role, organization_id INTO v_role, v_org
  FROM public.profiles WHERE id = v_actor;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ACTOR_PROFILE_NOT_FOUND');
  END IF;

  v_is_super := (v_role = 'super_admin');

  -- 2. Permission: super_admin bypass; otherwise require
  --    inter_org_exchange.view (inter_org_exchange.manage also implies it).
  v_can_view := v_is_super
    OR phoenix_profile_has_permission(v_actor, 'inter_org_exchange.view')
    OR phoenix_profile_has_permission(v_actor, 'inter_org_exchange.manage');

  IF NOT v_can_view THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;

  -- 3. Validate the optional status filter against the known status set.
  IF p_status IS NOT NULL AND p_status NOT IN (
    'requested', 'source_approved', 'source_rejected',
    'dispatched', 'received', 'completed', 'cancelled'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATUS');
  END IF;

  -- 4. Sanitize pagination: limit bounded to 1-100 (default 50), offset
  --    never negative (default 0). Never trust frontend bounds.
  v_limit  := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_offset := GREATEST(COALESCE(p_offset, 0), 0);

  -- 5. Org-scoped, optionally status-filtered, newest-first listing.
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', r.id,
      'alert_key', r.alert_key,
      'source_item_availability_id', r.source_item_availability_id,
      'target_item_availability_id', r.target_item_availability_id,
      'source_organization_id', r.source_organization_id,
      'target_organization_id', r.target_organization_id,
      'source_distribution_point_id', r.source_distribution_point_id,
      'target_distribution_point_id', r.target_distribution_point_id,
      'scientific_name', r.scientific_name,
      'concentration', r.concentration,
      'dosage_form', r.dosage_form,
      'source_trade_name', r.source_trade_name,
      'target_trade_name', r.target_trade_name,
      'requested_quantity', r.requested_quantity,
      'approved_quantity', r.approved_quantity,
      'received_quantity', r.received_quantity,
      'status', r.status,
      'severity_snapshot', r.severity_snapshot,
      'reason', r.reason,
      'notes', r.notes,
      'requested_by', r.requested_by,
      'approved_by', r.approved_by,
      'dispatched_by', r.dispatched_by,
      'received_by', r.received_by,
      'cancelled_by', r.cancelled_by,
      'movement_id_out', r.movement_id_out,
      'movement_id_in', r.movement_id_in,
      'requested_at', r.requested_at,
      'approved_at', r.approved_at,
      'dispatched_at', r.dispatched_at,
      'received_at', r.received_at,
      'completed_at', r.completed_at,
      'cancelled_at', r.cancelled_at,
      'created_at', r.created_at,
      'updated_at', r.updated_at
    )
    ORDER BY r.created_at DESC
  )
  INTO v_requests
  FROM (
    SELECT * FROM public.inter_org_exchange_requests
    WHERE (v_is_super OR source_organization_id = v_org OR target_organization_id = v_org)
      AND (p_status IS NULL OR status = p_status)
    ORDER BY created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) r;

  RETURN jsonb_build_object(
    'ok', true,
    'requests', coalesce(v_requests, '[]'::jsonb),
    'limit', v_limit,
    'offset', v_offset
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_get_inter_org_exchange_requests(text, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_inter_org_exchange_requests(text, integer, integer)
  TO authenticated;

-- =============================================================================
-- VERIFY
-- =============================================================================

DO $$
DECLARE
  v_fn_src text;
BEGIN
  -- A. All four functions exist.
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_create_inter_org_exchange_request'),
    'VERIFY FAILED: phoenix_create_inter_org_exchange_request not found';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_update_inter_org_exchange_status'),
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status not found';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_inter_org_exchange_events'),
    'VERIFY FAILED: phoenix_get_inter_org_exchange_events not found';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_inter_org_exchange_requests'),
    'VERIFY FAILED: phoenix_get_inter_org_exchange_requests not found';

  -- B. SECURITY DEFINER + search_path + key behavior on RPC 1.
  SELECT pg_get_functiondef(oid) INTO v_fn_src FROM pg_proc WHERE proname = 'phoenix_create_inter_org_exchange_request';
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%' AND v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: phoenix_create_inter_org_exchange_request missing SECURITY DEFINER/search_path';
  ASSERT v_fn_src LIKE '%auth.uid()%',
    'VERIFY FAILED: phoenix_create_inter_org_exchange_request does not require auth.uid()';
  ASSERT v_fn_src LIKE '%FOR UPDATE%',
    'VERIFY FAILED: phoenix_create_inter_org_exchange_request does not lock rows with FOR UPDATE';
  ASSERT v_fn_src LIKE '%phoenix_profile_has_permission%',
    'VERIFY FAILED: phoenix_create_inter_org_exchange_request does not check phoenix_profile_has_permission';
  ASSERT v_fn_src LIKE '%inter_org_exchange.request%' AND v_fn_src LIKE '%inter_org_exchange.manage%',
    'VERIFY FAILED: phoenix_create_inter_org_exchange_request does not check inter_org_exchange.request/manage';
  ASSERT v_fn_src LIKE '%organizations_must_differ%',
    'VERIFY FAILED: phoenix_create_inter_org_exchange_request missing org-distinctness guard';
  ASSERT v_fn_src LIKE '%alert_key_mismatch%',
    'VERIFY FAILED: phoenix_create_inter_org_exchange_request missing alert_key integrity check';
  ASSERT v_fn_src LIKE '%requested_quantity_must_be_positive%',
    'VERIFY FAILED: phoenix_create_inter_org_exchange_request missing positive-quantity guard';
  ASSERT v_fn_src LIKE '%duplicate_active_exchange_request%',
    'VERIFY FAILED: phoenix_create_inter_org_exchange_request does not handle the duplicate-active unique_violation';
  ASSERT v_fn_src LIKE '%INSERT INTO public.inter_org_exchange_events%',
    'VERIFY FAILED: phoenix_create_inter_org_exchange_request does not insert a requested event';
  ASSERT v_fn_src NOT LIKE '%UPDATE public.item_availability%',
    'VERIFY FAILED: phoenix_create_inter_org_exchange_request must never write to item_availability';

  -- C. SECURITY DEFINER + search_path + key behavior on RPC 2.
  SELECT pg_get_functiondef(oid) INTO v_fn_src FROM pg_proc WHERE proname = 'phoenix_update_inter_org_exchange_status';
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%' AND v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status missing SECURITY DEFINER/search_path';
  ASSERT v_fn_src LIKE '%auth.uid()%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status does not require auth.uid()';
  ASSERT v_fn_src LIKE '%FOR UPDATE%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status does not lock rows with FOR UPDATE';
  ASSERT v_fn_src LIKE '%exchange_request_terminal%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status missing terminal-status guard';
  ASSERT v_fn_src LIKE '%invalid_transition%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status missing invalid_transition guard';
  ASSERT v_fn_src LIKE '%reason_required%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status missing reason_required guard';
  ASSERT v_fn_src LIKE '%inter_org_exchange.approve%'
     AND v_fn_src LIKE '%inter_org_exchange.dispatch%'
     AND v_fn_src LIKE '%inter_org_exchange.receive%'
     AND v_fn_src LIKE '%inter_org_exchange.cancel%'
     AND v_fn_src LIKE '%inter_org_exchange.manage%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status does not check all five relevant permission keys';
  ASSERT v_fn_src LIKE '%approved_quantity_exceeds_requested%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status missing approved-quantity-vs-requested guard';
  ASSERT v_fn_src LIKE '%received_quantity_exceeds_approved%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status missing received-quantity-vs-approved guard';
  ASSERT v_fn_src LIKE '%source_quantity_insufficient%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status missing source-quantity-sufficiency guard';
  ASSERT v_fn_src LIKE '%''subtract''%' AND v_fn_src LIKE '%''add''%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status does not reuse the existing subtract/add movement types';
  ASSERT v_fn_src NOT LIKE '%''transfer_out''%' AND v_fn_src NOT LIKE '%''transfer_in''%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status must not invent a new movement_type value';
  ASSERT v_fn_src LIKE '%INSERT INTO public.item_availability_movements%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status does not insert into item_availability_movements';
  ASSERT v_fn_src LIKE '%movement_id_out%' AND v_fn_src LIKE '%movement_id_in%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status does not stamp movement_id_out/movement_id_in';
  ASSERT v_fn_src LIKE '%INSERT INTO public.inter_org_exchange_events%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status does not insert an event per transition';
  ASSERT v_fn_src NOT LIKE '%phoenix_apply_availability_movement(%',
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status must not call phoenix_apply_availability_movement';

  -- D. SECURITY DEFINER + search_path + org scope on RPC 3.
  SELECT pg_get_functiondef(oid) INTO v_fn_src FROM pg_proc WHERE proname = 'phoenix_get_inter_org_exchange_events';
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%' AND v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: phoenix_get_inter_org_exchange_events missing SECURITY DEFINER/search_path';
  ASSERT v_fn_src LIKE '%source_organization_id%' AND v_fn_src LIKE '%target_organization_id%',
    'VERIFY FAILED: phoenix_get_inter_org_exchange_events does not scope by source/target org';
  ASSERT v_fn_src LIKE '%inter_org_exchange_events%',
    'VERIFY FAILED: phoenix_get_inter_org_exchange_events does not read inter_org_exchange_events';

  -- E. SECURITY DEFINER + search_path + org scope + safe pagination on RPC 4.
  SELECT pg_get_functiondef(oid) INTO v_fn_src FROM pg_proc WHERE proname = 'phoenix_get_inter_org_exchange_requests';
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%' AND v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: phoenix_get_inter_org_exchange_requests missing SECURITY DEFINER/search_path';
  ASSERT v_fn_src LIKE '%source_organization_id = v_org OR target_organization_id = v_org%',
    'VERIFY FAILED: phoenix_get_inter_org_exchange_requests does not scope by source/target org';
  ASSERT v_fn_src LIKE '%LEAST(GREATEST%',
    'VERIFY FAILED: phoenix_get_inter_org_exchange_requests does not bound the limit parameter';

  -- F. Grants: authenticated only, anon/PUBLIC excluded, on all four.
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_create_inter_org_exchange_request'
      AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated missing EXECUTE on phoenix_create_inter_org_exchange_request';
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_create_inter_org_exchange_request'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon/PUBLIC has EXECUTE on phoenix_create_inter_org_exchange_request';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_update_inter_org_exchange_status'
      AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated missing EXECUTE on phoenix_update_inter_org_exchange_status';
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_update_inter_org_exchange_status'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon/PUBLIC has EXECUTE on phoenix_update_inter_org_exchange_status';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_get_inter_org_exchange_events'
      AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated missing EXECUTE on phoenix_get_inter_org_exchange_events';
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_get_inter_org_exchange_events'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon/PUBLIC has EXECUTE on phoenix_get_inter_org_exchange_events';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_get_inter_org_exchange_requests'
      AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated missing EXECUTE on phoenix_get_inter_org_exchange_requests';
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_get_inter_org_exchange_requests'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon/PUBLIC has EXECUTE on phoenix_get_inter_org_exchange_requests';

  -- G. No new direct table policy/grant was added on either exchange table
  --    beyond what migration 040 already established.
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inter_org_exchange_events'
  ), 'VERIFY FAILED: a policy exists on inter_org_exchange_events — none should (read-only via RPC 3)';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inter_org_exchange_requests'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
  ), 'VERIFY FAILED: an INSERT/UPDATE/DELETE policy exists on inter_org_exchange_requests — none should';
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'inter_org_exchange_events'
      AND grantee = 'authenticated' AND privilege_type = 'SELECT'
  ), 'VERIFY FAILED: authenticated must still not have direct SELECT on inter_org_exchange_events';

  -- H. Untouched: existing tables/RPCs still present.
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'inter_org_exchange_requests'
  ), 'VERIFY FAILED: inter_org_exchange_requests is missing (must not be touched)';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'inter_org_exchange_events'
  ), 'VERIFY FAILED: inter_org_exchange_events is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement'),
    'VERIFY FAILED: phoenix_apply_availability_movement is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_upsert_availability'),
    'VERIFY FAILED: phoenix_upsert_availability is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_update_inter_org_alert_state'),
    'VERIFY FAILED: phoenix_update_inter_org_alert_state is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_public_qr_payload'),
    'VERIFY FAILED: get_public_qr_payload is missing (must not be touched)';

  -- I. movement_type CHECK constraint on item_availability_movements is
  --    unchanged — still exactly the 4 original values, no transfer_out/
  --    transfer_in added.
  ASSERT (
    SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conname = 'item_availability_movements_type_chk'
  ) LIKE '%''set_exact''%''add''%''subtract''%''correction''%',
    'VERIFY FAILED: item_availability_movements_type_chk must still be exactly (set_exact, add, subtract, correction)';

  RAISE NOTICE '041 OK: 4 inter-org exchange RPCs created (create_inter_org_exchange_request, update_inter_org_exchange_status, get_inter_org_exchange_events, get_inter_org_exchange_requests) — SECURITY DEFINER, authenticated-only, org+permission gated, atomic row-locked movement only at received->completed reusing existing subtract/add movement types, no new table grants/policies, no existing RPC/table/constraint touched.';
END $$;

-- =============================================================================
-- END OF MIGRATION 041
--
-- Post-apply manual verification (run in Supabase SQL Editor):
--
-- 1. As a target-org user holding inter_org_exchange.request, create a
--    request from a real alert_key returned by
--    phoenix_get_live_inter_institution_alerts_with_state:
--    SELECT phoenix_create_inter_org_exchange_request(
--      '<alert_key>', NULL, '<source_item_availability_id>',
--      '<target_item_availability_id>', 10, 'pilot test', NULL);
--    -- expect { ok: true, exchange_request_id, alert_key, status: 'requested', ... }
--
-- 2. Confirm the duplicate-active guard:
--    -- re-run step 1 with the same alert_key -> expect ERROR
--    -- duplicate_active_exchange_request
--
-- 3. As a source-org user holding inter_org_exchange.approve:
--    SELECT phoenix_update_inter_org_exchange_status(
--      '<exchange_request_id>', 'source_approved', 8, NULL, NULL, NULL);
--    -- expect { ok: true, from_status: 'requested', to_status: 'source_approved' }
--
-- 4. Confirm an invalid transition is rejected:
--    SELECT phoenix_update_inter_org_exchange_status(
--      '<exchange_request_id>', 'completed', NULL, NULL, NULL, NULL);
--    -- expect: ERROR invalid_transition (source_approved -> completed is not allowed)
--
-- 5. As the source-org user, dispatch:
--    SELECT phoenix_update_inter_org_exchange_status(
--      '<exchange_request_id>', 'dispatched', NULL, NULL, NULL, NULL);
--
-- 6. As a target-org user holding inter_org_exchange.receive, confirm
--    receipt (no stock movement yet):
--    SELECT phoenix_update_inter_org_exchange_status(
--      '<exchange_request_id>', 'received', NULL, 8, NULL, NULL);
--
-- 7. Note the source item_availability's quantity BEFORE completion, then
--    complete (this is the only step that moves stock):
--    SELECT phoenix_update_inter_org_exchange_status(
--      '<exchange_request_id>', 'completed', NULL, NULL, NULL, NULL);
--    -- expect { ok: true, from_status: 'received', to_status: 'completed' }
--    -- confirm: source item_availability.quantity decreased by 8, target
--    -- item_availability.quantity increased by 8, and two new rows exist in
--    -- item_availability_movements (movement_type 'subtract' at source,
--    -- 'add' at target) whose ids match the request's
--    -- movement_id_out/movement_id_in:
--    SELECT movement_id_out, movement_id_in FROM inter_org_exchange_requests
--    WHERE id = '<exchange_request_id>';
--
-- 8. Confirm no further transition is possible (terminal status):
--    SELECT phoenix_update_inter_org_exchange_status(
--      '<exchange_request_id>', 'cancelled', NULL, NULL, 'x', NULL);
--    -- expect: ERROR exchange_request_terminal
--
-- 9. Confirm event history (oldest-first):
--    SELECT phoenix_get_inter_org_exchange_events('<exchange_request_id>');
--    -- expect { ok: true, events: [...] } in order: requested,
--    -- source_approved, dispatched, received, completed.
--
-- 10. Confirm the listing RPC:
--     SELECT phoenix_get_inter_org_exchange_requests('completed', 20, 0);
--     -- expect { ok: true, requests: [...] } including the request from
--     -- above, scoped to your organization only.
--
-- 11. Confirm no direct table access still works as expected on events
--     (should return 0 rows, since only RPC 3 may read it):
--     SELECT * FROM inter_org_exchange_events LIMIT 1; -- as authenticated, expect 0 rows
-- =============================================================================
