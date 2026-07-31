-- ============================================================================
-- 152 — Server-backed suggestion action read model
--
-- One bounded batch RPC answers what the current actor may do with suggestions
-- already visible to that actor. It does not authorize a later write: every
-- writer still reloads and revalidates server truth.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure(
       'public._phoenix_authorize_suggestion_draft_route_v1(uuid,public.inventory_transfer_suggestions)'
     ) IS NULL
     OR to_regprocedure(
       'public.phoenix_can_read_warehouse_transfer(uuid,uuid,uuid,uuid)'
     ) IS NULL
     OR to_regprocedure(
       'public.phoenix_can_read_warehouse_dispatch(uuid,uuid,uuid)'
     ) IS NULL
     OR to_regprocedure(
       'public.phoenix_can_read_outlet_return(uuid,uuid,uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'ABORT 152: expected Phase 7 route gate and corridor read boundaries are missing';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_get_inventory_suggestion_actions(
  p_suggestion_ids uuid[]
)
RETURNS TABLE (
  suggestion_id uuid,
  current_state text,
  allowed_actions jsonb,
  action_reason jsonb,
  route_kind text,
  document_kind text,
  document_id uuid,
  document_number text,
  freshness_state text,
  process_kind text,
  process_version integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_active boolean;
  v_s public.inventory_transfer_suggestions%ROWTYPE;
  v_policy_minutes integer;
  v_freshness text;
  v_can_route boolean;
  v_can_create boolean;
  v_can_reject boolean;
  v_can_open boolean;
  v_create_reason text;
  v_reject_reason text;
  v_open_reason text;
  v_document_kind text;
  v_document_id uuid;
  v_document_number text;
  v_document_status text;
  v_link_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT p.status = 'active'
    INTO v_actor_active
  FROM public.profiles p
  WHERE p.id = v_actor;
  IF COALESCE(v_actor_active, false) = false THEN
    RETURN;
  END IF;

  IF COALESCE(cardinality(p_suggestion_ids), 0) > 200 THEN
    RAISE EXCEPTION 'suggestion_action_batch_too_large'
      USING ERRCODE = '22023';
  END IF;

  FOR v_s IN
    SELECT s.*
    FROM public.inventory_transfer_suggestions s
    WHERE s.id = ANY(COALESCE(p_suggestion_ids, ARRAY[]::uuid[]))
      AND (
        public.phoenix_my_role() = 'super_admin'
        OR public.phoenix_can_read_inventory_signal(
             s.source_organization_id, s.source_scope_kind, s.source_scope_id
           )
        OR public.phoenix_can_read_inventory_signal(
             s.target_organization_id, s.target_scope_kind, s.target_scope_id
           )
      )
    ORDER BY array_position(p_suggestion_ids, s.id)
  LOOP
    v_can_create := false;
    v_can_reject := false;
    v_can_open := false;
    v_can_route := false;
    v_document_kind := NULL;
    v_document_id := NULL;
    v_document_number := NULL;
    v_document_status := NULL;
    v_link_id := NULL;

    SELECT p.staleness_minutes
      INTO v_policy_minutes
    FROM public.inventory_suggestion_policy p
    WHERE p.organization_id = v_s.source_organization_id;

    v_freshness := CASE
      WHEN v_s.status <> 'open' THEN 'not_applicable'
      WHEN v_s.last_validated_at IS NULL
        OR v_s.last_validated_at
             < now() - make_interval(mins => COALESCE(v_policy_minutes, 30))
        THEN 'stale'
      ELSE 'fresh'
    END;

    BEGIN
      -- Exact Migration 151 gate; route-role logic is not reproduced here.
      -- It also proves that the actor can enter the existing source-side
      -- document surface. A target-side RLS reader must not receive an Open
      -- action that routes to a writer-only page it cannot render.
      PERFORM public._phoenix_authorize_suggestion_draft_route_v1(v_actor, v_s);
      v_can_route := true;
    EXCEPTION
      WHEN insufficient_privilege
        OR invalid_authorization_specification
        OR check_violation THEN
        v_can_route := false;
    END;

    v_can_create :=
      v_s.status = 'open'
      AND v_freshness = 'fresh'
      AND v_can_route;

    -- Kept byte-for-byte equivalent to the reject writer's independent gate.
    v_can_reject := v_s.status = 'open' AND (
      public.phoenix_my_role() = 'super_admin'
      OR (
        v_s.source_scope_kind = 'warehouse'
        AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions',
          v_s.source_organization_id, v_s.source_scope_id, NULL
        )
      )
      OR (
        v_s.source_scope_kind = 'outlet'
        AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions',
          v_s.source_organization_id, NULL, v_s.source_scope_id
        )
      )
      OR (
        v_s.target_scope_kind = 'warehouse'
        AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions',
          v_s.target_organization_id, v_s.target_scope_id, NULL
        )
      )
      OR (
        v_s.target_scope_kind = 'outlet'
        AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions',
          v_s.target_organization_id, NULL, v_s.target_scope_id
        )
      )
    );

    IF v_s.status = 'accepted' THEN
      CASE v_s.route_kind
        WHEN 'central_to_institution' THEN
          v_link_id := v_s.draft_warehouse_transfer_request_id;
          IF v_link_id IS NOT NULL THEN
            SELECT r.status, r.request_number
              INTO v_document_status, v_document_number
            FROM public.warehouse_transfer_requests r
            WHERE r.id = v_link_id
              AND public.phoenix_can_read_warehouse_transfer(
                    r.source_organization_id, r.source_warehouse_id,
                    r.destination_organization_id, r.destination_warehouse_id
                  );
            IF FOUND THEN
              v_document_kind := 'warehouse_transfer_request';
              v_document_id := v_link_id;
            END IF;
          END IF;

        WHEN 'warehouse_to_outlet' THEN
          v_link_id := v_s.draft_warehouse_dispatch_id;
          IF v_link_id IS NOT NULL THEN
            SELECT d.status, d.dispatch_number
              INTO v_document_status, v_document_number
            FROM public.warehouse_dispatches d
            WHERE d.id = v_link_id
              AND public.phoenix_can_read_warehouse_dispatch(
                    d.organization_id, d.warehouse_id,
                    d.destination_distribution_point_id
                  );
            IF FOUND THEN
              v_document_kind := 'warehouse_dispatch';
              v_document_id := v_link_id;
            END IF;
          END IF;

        WHEN 'outlet_to_warehouse' THEN
          v_link_id := v_s.draft_outlet_return_request_id;
          IF v_link_id IS NOT NULL THEN
            SELECT r.status, r.return_number
              INTO v_document_status, v_document_number
            FROM public.outlet_return_requests r
            WHERE r.id = v_link_id
              AND public.phoenix_can_read_outlet_return(
                    r.source_organization_id, r.distribution_point_id,
                    r.destination_warehouse_id
                  );
            IF FOUND THEN
              v_document_kind := 'outlet_return_request';
              v_document_id := v_link_id;
            END IF;
          END IF;
      END CASE;
    END IF;

    v_can_open :=
      v_s.status = 'accepted'
      AND v_document_id IS NOT NULL
      AND v_can_route;

    v_create_reason := CASE
      WHEN v_can_create THEN 'ready'
      WHEN v_s.status <> 'open' THEN 'suggestion_not_open'
      WHEN v_freshness = 'stale' THEN 'stale_revalidation_required'
      ELSE 'route_permission_required'
    END;
    v_reject_reason := CASE
      WHEN v_can_reject THEN 'ready'
      WHEN v_s.status <> 'open' THEN 'suggestion_not_open'
      ELSE 'suggestion_permission_required'
    END;
    v_open_reason := CASE
      WHEN v_can_open AND v_s.lineage_state = 'line_deleted'
        THEN 'document_line_deleted'
      WHEN v_can_open THEN 'document_available'
      WHEN v_s.status <> 'accepted' THEN 'suggestion_not_accepted'
      WHEN v_link_id IS NULL THEN 'document_link_missing'
      WHEN v_document_id IS NOT NULL AND NOT v_can_route
        THEN 'route_permission_required'
      ELSE 'document_unavailable'
    END;

    suggestion_id := v_s.id;
    current_state := CASE
      WHEN v_s.status = 'open' THEN 'open_' || v_freshness
      WHEN v_s.status = 'accepted' AND v_document_id IS NULL
        THEN CASE WHEN v_link_id IS NULL
          THEN 'accepted_document_link_missing'
          ELSE 'accepted_document_unavailable'
        END
      WHEN v_s.status = 'accepted' AND v_s.lineage_state = 'line_deleted'
        THEN 'accepted_document_line_deleted'
      WHEN v_s.status = 'accepted'
        THEN 'accepted_document_' || COALESCE(v_document_status, 'available')
      ELSE v_s.status
    END;
    allowed_actions := jsonb_build_object(
      'createDraft', v_can_create,
      'reject', v_can_reject,
      'openDocument', v_can_open
    );
    action_reason := jsonb_build_object(
      'createDraft', v_create_reason,
      'reject', v_reject_reason,
      'openDocument', v_open_reason
    );
    route_kind := v_s.route_kind;
    document_kind := v_document_kind;
    document_id := v_document_id;
    document_number := v_document_number;
    freshness_state := v_freshness;
    process_kind := CASE v_s.route_kind
      WHEN 'central_to_institution' THEN 'warehouse_transfer_request'
      WHEN 'warehouse_to_outlet' THEN 'warehouse_dispatch'
      WHEN 'outlet_to_warehouse' THEN 'outlet_return_request'
      ELSE 'unsupported'
    END;
    process_version := 1;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_get_inventory_suggestion_actions(uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_inventory_suggestion_actions(uuid[])
  TO authenticated;

DO $$
BEGIN
  IF EXISTS (
       SELECT 1
       FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(
         COALESCE(p.proacl, acldefault('f', p.proowner))
       ) acl
       WHERE p.oid =
         'public.phoenix_get_inventory_suggestion_actions(uuid[])'::regprocedure
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.phoenix_get_inventory_suggestion_actions(uuid[])',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.phoenix_get_inventory_suggestion_actions(uuid[])',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (152): suggestion action read-model ACL drift';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.phoenix_get_inventory_suggestion_actions(uuid[]) IS
  'PHASE-8-152: bounded, read-only batch action model for already-visible '
  'suggestions. Uses the Phase 7 create gate, keeps reject independent, and '
  'returns a linked document only through the real corridor read boundary. '
  'A positive result is display-time information, never a reusable grant.';

COMMIT;
