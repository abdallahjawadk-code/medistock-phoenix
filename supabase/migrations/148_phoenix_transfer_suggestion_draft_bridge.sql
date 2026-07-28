-- =============================================================================
-- MediStock Phoenix — Migration 148: Transfer Suggestion Draft Bridge
-- MANUAL APPLY ONLY. DO NOT use `npx supabase db push` or any automated runner.
-- Apply after 145. Forward-only — no applied migration is edited.
-- =============================================================================
--
-- WHAT THIS CLOSES
-- -----------------------------------------------------------------------------
-- Migration 072 built a real, FEFO-guarded, conservation-checked transfer
-- recommendation engine (inventory_transfer_suggestions), but structurally
-- forbade acting on it: `inventory_suggestions_no_accept_chk` makes
-- status='accepted' impossible for ANY writer, including service_role, and
-- `phoenix_accept_inventory_transfer_suggestion` unconditionally raised
-- 'acceptance_disabled_recommendation_only'. Separately, three real, live,
-- hardened execution corridors already exist and were never connected to any
-- suggestion: warehouse_transfer_requests (068/077, central<->institution),
-- warehouse_dispatches (070, warehouse->outlet), outlet_return_requests (071,
-- outlet->warehouse).
--
-- This migration bridges ONE suggestion to ONE real draft document in its own
-- corridor's existing RPCs, per route_kind:
--   central_to_institution -> phoenix_create_direct_warehouse_transfer_request
--                              + phoenix_add_warehouse_transfer_request_line  (068/077)
--   warehouse_to_outlet    -> phoenix_create_warehouse_dispatch
--                              + phoenix_add_dispatch_line_fefo_guarded        (070/107)
--   outlet_to_warehouse    -> phoenix_request_outlet_return
--                              + phoenix_add_outlet_return_request_line       (071)
--
-- No fourth movement engine is introduced. inter_org_exchange_requests
-- (migrations 040/041) is NOT resurrected — it remains in the database,
-- unused, as it was before this migration (no runtime caller then or now).
--
-- NAMING (reviewer requirement): the new RPC is named
-- `phoenix_create_transfer_draft_from_suggestion`, not "accept" — its result
-- is a DRAFT document in the normal submit/review/send/receive lifecycle of
-- its corridor, never a stock movement by itself. `inventory_transfer_
-- suggestions.status` keeps its existing 'accepted' enum spelling (renaming
-- it would require re-deriving ~20 call sites inside the large, already-
-- applied allocator/guard functions in 072/077 solely for a cosmetic rename,
-- for no safety benefit — those functions are untouched by this migration).
-- Every user-facing surface (RPC name, audit log, UI copy, tests) says
-- "draft", never "accept"/"execute". What DOES change, and is the actual
-- safety fix: status='accepted' now REQUIRES a real foreign key to one of the
-- three document tables above (enforced by
-- inventory_suggestions_draft_fk_matches_route_chk below) — a bare UUID can
-- no longer stand in for proof a document exists.
--
-- DEPRECATION NOTE (reviewer requirement, no deletion in this migration):
-- src/features/alerts/inter-institution-alerts.service.ts + .ts (migration
-- 009 legacy RPC wrapper) are marked @deprecated in a prior commit on this
-- branch. Neither this migration nor this branch drops the 009 RPC or the
-- 040/041 tables/RPCs — physical removal is deferred to an independent
-- cleanup PR after a monitoring window, per review guidance on this
-- high-risk change.
-- =============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.inventory_transfer_suggestions') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 072 inventory_transfer_suggestions is missing';
  END IF;
  IF to_regclass('public.warehouse_transfer_requests') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 068 warehouse_transfer_requests is missing';
  END IF;
  IF to_regclass('public.warehouse_dispatches') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 061 warehouse_dispatches is missing';
  END IF;
  IF to_regclass('public.outlet_return_requests') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 071 outlet_return_requests is missing';
  END IF;
  IF to_regprocedure('public.phoenix_create_direct_warehouse_transfer_request(uuid,uuid,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 077 phoenix_create_direct_warehouse_transfer_request is missing';
  END IF;
  IF to_regprocedure('public.phoenix_add_warehouse_transfer_request_line(uuid,text,integer,uuid,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 077 phoenix_add_warehouse_transfer_request_line is missing';
  END IF;
  IF to_regprocedure('public.phoenix_create_warehouse_dispatch(uuid,uuid,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 070 phoenix_create_warehouse_dispatch is missing';
  END IF;
  IF to_regprocedure('public.phoenix_add_dispatch_line_fefo_guarded(uuid,uuid,integer,boolean,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 107 phoenix_add_dispatch_line_fefo_guarded is missing';
  END IF;
  IF to_regprocedure('public.phoenix_request_outlet_return(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 071 phoenix_request_outlet_return is missing';
  END IF;
  IF to_regprocedure('public.phoenix_add_outlet_return_request_line(uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 071 phoenix_add_outlet_return_request_line is missing';
  END IF;
  IF to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state(integer)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 039 phoenix_get_live_inter_institution_alerts_with_state is missing';
  END IF;
END;
$precond$;

-- ============================================================================
-- 1. STRUCTURAL PROOF — three real FK columns, no polymorphic UUID.
-- ============================================================================
ALTER TABLE public.inventory_transfer_suggestions
  ADD COLUMN IF NOT EXISTS draft_warehouse_transfer_request_id uuid
    REFERENCES public.warehouse_transfer_requests(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS draft_warehouse_dispatch_id uuid
    REFERENCES public.warehouse_dispatches(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS draft_outlet_return_request_id uuid
    REFERENCES public.outlet_return_requests(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS draft_document_number text;

COMMENT ON COLUMN public.inventory_transfer_suggestions.draft_warehouse_transfer_request_id IS
  'Set only when route_kind=central_to_institution and status=accepted. Real FK — '
  'proves a warehouse_transfer_requests draft exists; never a bare id.';
COMMENT ON COLUMN public.inventory_transfer_suggestions.draft_warehouse_dispatch_id IS
  'Set only when route_kind=warehouse_to_outlet and status=accepted. Real FK — '
  'proves a warehouse_dispatches draft exists; never a bare id.';
COMMENT ON COLUMN public.inventory_transfer_suggestions.draft_outlet_return_request_id IS
  'Set only when route_kind=outlet_to_warehouse and status=accepted. Real FK — '
  'proves an outlet_return_requests draft exists; never a bare id.';
COMMENT ON COLUMN public.inventory_transfer_suggestions.accepted_at IS
  '148: timestamps when phoenix_create_transfer_draft_from_suggestion created a '
  'real draft document in the corridor matching route_kind — NOT an execution, '
  'acceptance, or stock movement. The stock movement happens later, only via the '
  'draft document''s own send/receive RPCs.';
COMMENT ON COLUMN public.inventory_transfer_suggestions.accepted_by IS
  '148: actor who created the draft document (see accepted_at). Reserved column '
  'name kept from 072 for schema stability; semantics documented here.';

-- Drop the Round-5 total prohibition — replaced below by a narrower rule that
-- permits status='accepted' ONLY when a real, FK-proven draft document for the
-- matching route_kind exists (never a bare id, never any other route_kind).
ALTER TABLE public.inventory_transfer_suggestions
  DROP CONSTRAINT IF EXISTS inventory_suggestions_no_accept_chk,
  DROP CONSTRAINT IF EXISTS inventory_suggestions_no_accept_fields_chk;

ALTER TABLE public.inventory_transfer_suggestions
  ADD CONSTRAINT inventory_suggestions_draft_fk_matches_route_chk CHECK (
    CASE
      WHEN status <> 'accepted' THEN
        draft_warehouse_transfer_request_id IS NULL
        AND draft_warehouse_dispatch_id IS NULL
        AND draft_outlet_return_request_id IS NULL
      WHEN route_kind = 'central_to_institution' THEN
        draft_warehouse_transfer_request_id IS NOT NULL
        AND draft_warehouse_dispatch_id IS NULL
        AND draft_outlet_return_request_id IS NULL
      WHEN route_kind = 'warehouse_to_outlet' THEN
        draft_warehouse_dispatch_id IS NOT NULL
        AND draft_warehouse_transfer_request_id IS NULL
        AND draft_outlet_return_request_id IS NULL
      WHEN route_kind = 'outlet_to_warehouse' THEN
        draft_outlet_return_request_id IS NOT NULL
        AND draft_warehouse_transfer_request_id IS NULL
        AND draft_warehouse_dispatch_id IS NULL
      ELSE false
    END
  );

ALTER TABLE public.inventory_transfer_suggestions
  ADD CONSTRAINT inventory_suggestions_accept_fields_chk CHECK (
    (status = 'accepted') = (
      accepted_at IS NOT NULL AND accepted_by IS NOT NULL
      AND draft_document_number IS NOT NULL AND btrim(draft_document_number) <> ''
    )
  );

-- The old stub never had a real caller (it only ever raised an exception) and
-- is fully superseded by phoenix_create_transfer_draft_from_suggestion below.
DROP FUNCTION IF EXISTS public.phoenix_accept_inventory_transfer_suggestion(uuid);

-- ============================================================================
-- 2. STALENESS POLICY — admin-configurable, documented default, never a
--    silent literal inside the draft-creation RPC.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.inventory_suggestion_policy (
  organization_id   uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  staleness_minutes integer NOT NULL DEFAULT 30
    CONSTRAINT inventory_suggestion_policy_staleness_chk CHECK (staleness_minutes BETWEEN 1 AND 1440),
  updated_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.inventory_suggestion_policy IS
  '148: per-organization override of how long a suggestion''s last_validated_at '
  'may age before phoenix_create_transfer_draft_from_suggestion refuses it and '
  'requires re-validation. No row = 30-minute documented default.';

ALTER TABLE public.inventory_suggestion_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inventory_suggestion_policy FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.inventory_suggestion_policy TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory_suggestion_policy FROM authenticated;

DROP POLICY IF EXISTS inventory_suggestion_policy_select_scoped ON public.inventory_suggestion_policy;
CREATE POLICY inventory_suggestion_policy_select_scoped
  ON public.inventory_suggestion_policy FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'super_admin'
    OR organization_id = public.phoenix_my_org()
  );

CREATE OR REPLACE FUNCTION public.phoenix_upsert_inventory_suggestion_policy(
  p_organization_id   uuid,
  p_staleness_minutes integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_status text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_organization_id IS NULL THEN RAISE EXCEPTION 'organization_id_required'; END IF;
  IF p_staleness_minutes IS NULL OR p_staleness_minutes < 1 OR p_staleness_minutes > 1440 THEN
    RAISE EXCEPTION 'staleness_minutes_out_of_range';
  END IF;

  SELECT status INTO v_actor_status FROM public.profiles WHERE id = v_actor;
  IF NOT FOUND OR v_actor_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'not_authorized_inventory_manage_thresholds';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id) THEN
    RAISE EXCEPTION 'organization_not_found';
  END IF;

  -- CROSS-ORG-IDOR-148-FIX: the previous unscoped phoenix_profile_has_permission
  -- check let any actor holding inventory.manage_thresholds anywhere rewrite
  -- ANY organization's suggestion policy by supplying an arbitrary
  -- p_organization_id. phoenix_profile_has_scoped_permission (091) already
  -- enforces active status, a super_admin bypass, and p_organization_id
  -- matching the actor's OWN organization_id before checking the permission
  -- key — exactly the org-scoping this table (one row per org, no
  -- warehouse/outlet dimension) needs, matching 092's
  -- phoenix_upsert_inventory_threshold org-default (NULL scope_id) branch.
  -- The central_warehouse_manager OR-clause mirrors that same 092 carve-out:
  -- v_org_wide_roles inside phoenix_profile_has_scoped_permission is
  -- ['institution_admin'] only (091), but 092 narrowed
  -- inventory.manage_thresholds to central_warehouse_manager alone — without
  -- this clause the only role that legitimately holds the permission could
  -- never pass the scoped check for its own organization's default row. This
  -- grants nothing new: it still requires the actor's OWN org to match and
  -- the permission key to already be true, and this function's own
  -- active-status check above already ran first.
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(
         v_actor, 'inventory.manage_thresholds', p_organization_id, NULL, NULL)
    OR (public.phoenix_my_role() = 'central_warehouse_manager'
        AND public.phoenix_my_org() = p_organization_id
        AND public.phoenix_profile_has_permission(v_actor, 'inventory.manage_thresholds'))
  ) THEN
    RAISE EXCEPTION 'not_authorized_inventory_manage_thresholds';
  END IF;

  INSERT INTO public.inventory_suggestion_policy (organization_id, staleness_minutes, updated_by, updated_at)
  VALUES (p_organization_id, p_staleness_minutes, v_actor, now())
  ON CONFLICT (organization_id) DO UPDATE SET
    staleness_minutes = EXCLUDED.staleness_minutes,
    updated_by = EXCLUDED.updated_by,
    updated_at = EXCLUDED.updated_at;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (p_organization_id, v_actor, public.phoenix_my_role(), 'update', 'inventory_suggestion_policy',
          p_organization_id, 'staleness_minutes', jsonb_build_object('staleness_minutes', p_staleness_minutes));

  RETURN jsonb_build_object('ok', true, 'organization_id', p_organization_id, 'staleness_minutes', p_staleness_minutes);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_upsert_inventory_suggestion_policy(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_upsert_inventory_suggestion_policy(uuid, integer) TO authenticated;

-- ============================================================================
-- 2b. 4B canonical resource-lock guardian.
--
-- Every caller supplies its complete logical resource set before taking a
-- conflicting stock/threshold/provenance row lock. Sorting is centralized so
-- no caller can accidentally turn A->B / B->A into opposite lock orders.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._phoenix_lock_inventory_resources(p_keys text[])
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
BEGIN
  FOR v_key IN
    SELECT DISTINCT btrim(k)
    FROM unnest(COALESCE(p_keys, ARRAY[]::text[])) AS u(k)
    WHERE NULLIF(btrim(k), '') IS NOT NULL
    ORDER BY btrim(k)
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_lock_inventory_resources(text[]) FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 2c. _phoenix_live_suggestion_scope_position — LIVE-BALANCE-FIX-148.
--
--     LIVE re-derivation of a single (organization, scope, material, code)
--     position's available quantity and effective threshold, locking every
--     contributing row so the caller's transaction can rely on the returned
--     numbers until it commits.
--
--     Internal only (REVOKEd from PUBLIC/anon/authenticated below — called
--     exclusively from phoenix_create_transfer_draft_from_suggestion). Its
--     own SECURITY DEFINER context already carries every privilege this
--     helper needs, so SECURITY INVOKER is sufficient — no elevation beyond
--     what the caller already has is required.
--
--     Mirrors phoenix_recompute_inventory_alerts' (072) OWN eligibility and
--     threshold-resolution rules EXACTLY, re-scoped to one known position
--     instead of the whole organization — this is a narrow re-derivation of
--     an EXISTING rule, not a new movement/decision engine:
--       * live_available is SUM(available_quantity) over EVERY matching row.
--         072's own quantity-signal aggregate (_stock/_agg) does not exclude
--         expired batches either; this function does not invent a stricter
--         rule than the one it replaces as the source of truth.
--       * a CODED position (p_national_code IS NOT NULL) measures exactly
--         that code's rows.
--       * a WILDCARD position (p_national_code IS NULL) measures every code
--         of the material EXCEPT codes covered by their own coded threshold
--         — verbatim 072's _pos/tot wildcard-exclusion rule.
--       * the effective threshold is the scope-specific row if one exists
--         and is_active, else the organization-default (scope_id IS NULL)
--         row — verbatim 072's "ORDER BY (scope_id IS NOT NULL) DESC" rule.
--
--     Locking: the bridge first takes canonical advisory resources and
--     pre-locks both scope anchors plus all currently matching stock rows in
--     one global order. The scope-row FOR UPDATE locks conflict with the FK
--     KEY SHARE check of a concurrent stock INSERT, covering a missing row or
--     a newly arriving batch without relying on a nonexistent predicate lock.
--     Every contributing stock row, and every candidate threshold
--     row (at most the scope-specific one and the org-default one, per
--     inventory_thresholds_identity_uniq), is locked in a deterministic
--     order via a PL/pgSQL "FOR r IN SELECT ... FOR UPDATE LOOP" cursor —
--     Postgres does not allow FOR UPDATE together with an aggregate in the
--     same query, so the sum is only accumulated as each row is locked, and
--     the caller never sees a value until every contributing row is locked.
--
--     Threshold INSERT/UPDATE is serialized by the shared inv_threshold key
--     installed below. Existing stock writers remain unchanged: updates
--     serialize on their stock row and inserts serialize on the locked scope
--     anchor through the existing composite FK.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._phoenix_live_suggestion_scope_position(
  p_organization_id uuid,
  p_scope_kind      text,
  p_scope_id        uuid,
  p_scientific_name text,
  p_national_code   text
)
RETURNS TABLE (live_available integer, reorder_point integer, target_max integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sci             text := lower(btrim(p_scientific_name));
  v_sum             integer := 0;
  v_scope_row       boolean := false;
  v_default_row     boolean := false;
  v_scope_reorder   integer;
  v_scope_target    integer;
  v_default_reorder integer;
  v_default_target  integer;
  v_reorder         integer;
  v_target          integer;
  r                 RECORD;
BEGIN
  IF p_scope_kind NOT IN ('warehouse', 'outlet') THEN
    RAISE EXCEPTION 'invalid_scope_kind';
  END IF;
  IF public.phoenix_inventory_scope_org(p_scope_kind, p_scope_id) IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'scope_not_in_organization';
  END IF;

  -- ── Lock every contributing stock row, ascending id order, sum as we go ──
  IF p_scope_kind = 'warehouse' THEN
    FOR r IN
      SELECT ws.available_quantity
      FROM public.warehouse_stock ws
      WHERE ws.organization_id = p_organization_id
        AND ws.warehouse_id = p_scope_id
        AND lower(ws.scientific_name) = v_sci
        AND (
          (p_national_code IS NOT NULL AND ws.national_code IS NOT DISTINCT FROM p_national_code)
          OR (p_national_code IS NULL AND NOT EXISTS (
                SELECT 1 FROM public.inventory_signal_thresholds tc
                WHERE tc.organization_id = p_organization_id
                  AND tc.scope_kind = p_scope_kind
                  AND (tc.scope_id = p_scope_id OR tc.scope_id IS NULL)
                  AND tc.is_active
                  AND lower(tc.scientific_name) = v_sci
                  AND tc.national_code IS NOT NULL
                  AND tc.national_code = ws.national_code
              ))
        )
      ORDER BY ws.id
      FOR UPDATE
    LOOP
      v_sum := v_sum + COALESCE(r.available_quantity, 0);
    END LOOP;
  ELSE
    FOR r IN
      SELECT os.available_quantity
      FROM public.outlet_stock os
      WHERE os.organization_id = p_organization_id
        AND os.distribution_point_id = p_scope_id
        AND lower(os.scientific_name) = v_sci
        AND (
          (p_national_code IS NOT NULL AND os.national_code IS NOT DISTINCT FROM p_national_code)
          OR (p_national_code IS NULL AND NOT EXISTS (
                SELECT 1 FROM public.inventory_signal_thresholds tc
                WHERE tc.organization_id = p_organization_id
                  AND tc.scope_kind = p_scope_kind
                  AND (tc.scope_id = p_scope_id OR tc.scope_id IS NULL)
                  AND tc.is_active
                  AND lower(tc.scientific_name) = v_sci
                  AND tc.national_code IS NOT NULL
                  AND tc.national_code = os.national_code
              ))
        )
      ORDER BY os.id
      FOR UPDATE
    LOOP
      v_sum := v_sum + COALESCE(r.available_quantity, 0);
    END LOOP;
  END IF;

  -- ── Lock both threshold candidates (scope-specific + org-default), then
  --    pick the effective one — scope-specific wins, verbatim 072's rule.
  --    Locked in a fixed order (scope-specific first) so two concurrent
  --    calls for the SAME position can never deadlock against each other.
  FOR r IN
    SELECT t.scope_id, t.reorder_point, t.target_max
    FROM public.inventory_signal_thresholds t
    WHERE t.organization_id = p_organization_id
      AND t.scope_kind = p_scope_kind
      AND (t.scope_id = p_scope_id OR t.scope_id IS NULL)
      AND t.is_active
      AND lower(t.scientific_name) = v_sci
      AND t.national_code IS NOT DISTINCT FROM p_national_code
    ORDER BY (t.scope_id IS NULL), t.id
    FOR UPDATE
  LOOP
    IF r.scope_id IS NOT NULL THEN
      v_scope_row := true; v_scope_reorder := r.reorder_point; v_scope_target := r.target_max;
    ELSE
      v_default_row := true; v_default_reorder := r.reorder_point; v_default_target := r.target_max;
    END IF;
  END LOOP;

  IF v_scope_row THEN
    v_reorder := v_scope_reorder; v_target := v_scope_target;
  ELSIF v_default_row THEN
    v_reorder := v_default_reorder; v_target := v_default_target;
  ELSE
    v_reorder := NULL; v_target := NULL;
  END IF;

  RETURN QUERY SELECT v_sum, v_reorder, v_target;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_live_suggestion_scope_position(uuid, text, uuid, text, text) FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 2d. Threshold writers join the same broad material resource before their
-- first conflicting row lock. The key deliberately covers org-default and
-- scope-specific rows plus coded and wildcard rows.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_upsert_inventory_threshold(
  p_organization_id  uuid,
  p_scope_kind       text,
  p_scope_id         uuid,
  p_scientific_name  text,
  p_national_code    text DEFAULT NULL,
  p_reorder_point    integer DEFAULT NULL,
  p_target_max       integer DEFAULT NULL,
  p_near_expiry_days integer DEFAULT NULL,
  p_is_active        boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name  text := NULLIF(btrim(p_scientific_name), '');
  v_code  text := NULLIF(btrim(p_national_code), '');
  v_id    uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_scope_kind NOT IN ('warehouse', 'outlet') THEN RAISE EXCEPTION 'invalid_scope_kind'; END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'scientific_name_required'; END IF;
  IF p_near_expiry_days IS NOT NULL AND (p_near_expiry_days < 1 OR p_near_expiry_days > 270) THEN
    RAISE EXCEPTION 'near_expiry_days_out_of_range';
  END IF;
  IF p_scope_id IS NOT NULL
     AND public.phoenix_inventory_scope_org(p_scope_kind, p_scope_id) IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'scope_not_in_organization';
  END IF;
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR (p_scope_id IS NOT NULL AND p_scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_thresholds', p_organization_id, p_scope_id, NULL))
    OR (p_scope_id IS NOT NULL AND p_scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_thresholds', p_organization_id, NULL, p_scope_id))
    OR (p_scope_id IS NULL AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_thresholds', p_organization_id, NULL, NULL))
    OR (p_scope_id IS NULL AND public.phoenix_my_role() = 'central_warehouse_manager'
        AND public.phoenix_my_org() = p_organization_id
        AND public.phoenix_profile_has_permission(v_actor, 'inventory.manage_thresholds'))
  ) THEN RAISE EXCEPTION 'not_authorized_inventory_manage_thresholds'; END IF;

  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_threshold:' || p_organization_id::text || ':' || p_scope_kind || ':' || lower(v_name)
  ]);

  INSERT INTO public.inventory_signal_thresholds AS t (
    organization_id, scope_kind, scope_id, scientific_name, national_code,
    reorder_point, target_max, near_expiry_days, is_active, created_by, updated_by
  ) VALUES (
    p_organization_id, p_scope_kind, p_scope_id, v_name, v_code,
    p_reorder_point, p_target_max, p_near_expiry_days, COALESCE(p_is_active, true), v_actor, v_actor
  )
  ON CONFLICT (organization_id, scope_kind,
               COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
               lower(scientific_name), COALESCE(national_code, ''))
  DO UPDATE SET
    reorder_point = EXCLUDED.reorder_point, target_max = EXCLUDED.target_max,
    near_expiry_days = EXCLUDED.near_expiry_days, is_active = EXCLUDED.is_active,
    updated_by = v_actor, updated_at = now()
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (p_organization_id, v_actor, public.phoenix_my_role(), 'update', 'inventory_signal_threshold', v_id,
          p_scope_kind || ':' || v_name,
          jsonb_build_object('reorder_point', p_reorder_point, 'target_max', p_target_max,
                             'near_expiry_days', p_near_expiry_days, 'is_active', COALESCE(p_is_active, true)));

  RETURN jsonb_build_object('id', v_id, 'organization_id', p_organization_id, 'scope_kind', p_scope_kind);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_upsert_inventory_threshold(uuid, text, uuid, text, text, integer, integer, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_upsert_inventory_threshold(uuid, text, uuid, text, text, integer, integer, integer, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_set_inventory_threshold_planning(
  p_threshold_id   uuid,
  p_safety_stock   integer DEFAULT NULL,
  p_lead_time_days integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_row   public.inventory_signal_thresholds%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_safety_stock IS NOT NULL AND p_safety_stock < 0 THEN RAISE EXCEPTION 'invalid_safety_stock'; END IF;
  IF p_lead_time_days IS NOT NULL AND p_lead_time_days < 0 THEN RAISE EXCEPTION 'invalid_lead_time_days'; END IF;

  SELECT * INTO v_row FROM public.inventory_signal_thresholds WHERE id = p_threshold_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'threshold_not_found'; END IF;

  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR (v_row.scope_id IS NOT NULL AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_thresholds', v_row.organization_id,
          CASE WHEN v_row.scope_kind = 'warehouse' THEN v_row.scope_id END,
          CASE WHEN v_row.scope_kind = 'outlet' THEN v_row.scope_id END))
    OR (v_row.scope_id IS NULL AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_thresholds', v_row.organization_id, NULL, NULL))
    OR (v_row.scope_id IS NULL AND public.phoenix_my_role() = 'central_warehouse_manager'
        AND public.phoenix_my_org() = v_row.organization_id
        AND public.phoenix_profile_has_permission(v_actor, 'inventory.manage_thresholds'))
  ) THEN RAISE EXCEPTION 'not_authorized_inventory_manage_thresholds'; END IF;

  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_threshold:' || v_row.organization_id::text || ':' || v_row.scope_kind || ':'
      || lower(btrim(v_row.scientific_name))
  ]);

  UPDATE public.inventory_signal_thresholds
  SET safety_stock = p_safety_stock, lead_time_days = p_lead_time_days,
      updated_by = v_actor, updated_at = now()
  WHERE id = p_threshold_id;

  RETURN jsonb_build_object('ok', true, 'threshold_id', p_threshold_id);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_set_inventory_threshold_planning(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_set_inventory_threshold_planning(uuid, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_batch_upsert_inventory_threshold(
  p_organization_id uuid,
  p_scope_kind      text,
  p_scope_id        uuid,
  p_items           jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_item        jsonb;
  v_result      jsonb;
  v_results     jsonb := '[]'::jsonb;
  v_result_by_ord jsonb[] := ARRAY[]::jsonb[];
  v_keys        text[];
  v_ord         integer;
  v_n           integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'items_required';
  END IF;
  IF jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'batch_too_large' USING DETAIL = 'max 200 materials per batch call';
  END IF;

  SELECT array_agg(DISTINCT
           'inv_threshold:' || p_organization_id::text || ':' || p_scope_kind || ':'
             || lower(btrim(elem ->> 'scientific_name'))
           ORDER BY
           'inv_threshold:' || p_organization_id::text || ':' || p_scope_kind || ':'
             || lower(btrim(elem ->> 'scientific_name')))
    INTO v_keys
  FROM jsonb_array_elements(p_items) AS x(elem);
  PERFORM public._phoenix_lock_inventory_resources(v_keys);

  -- Apply in canonical material/code order, but preserve the JSON result in
  -- the caller's original order through the ordinal-indexed result array.
  FOR v_item, v_ord IN
    SELECT elem, ord::integer
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS x(elem, ord)
    ORDER BY lower(btrim(elem ->> 'scientific_name')),
             COALESCE(NULLIF(btrim(elem ->> 'national_code'), ''), ''),
             ord
  LOOP
    v_result := public.phoenix_upsert_inventory_threshold(
      p_organization_id,
      p_scope_kind,
      p_scope_id,
      v_item ->> 'scientific_name',
      v_item ->> 'national_code',
      NULLIF(v_item ->> 'reorder_point', '')::integer,
      NULLIF(v_item ->> 'target_max', '')::integer,
      NULLIF(v_item ->> 'near_expiry_days', '')::integer,
      COALESCE((v_item ->> 'is_active')::boolean, true)
    );
    v_result_by_ord[v_ord] := v_result;
    v_n := v_n + 1;
  END LOOP;

  FOREACH v_result IN ARRAY v_result_by_ord LOOP
    v_results := v_results || jsonb_build_array(v_result);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', v_n, 'results', v_results);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_batch_upsert_inventory_threshold(uuid, text, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_batch_upsert_inventory_threshold(uuid, text, uuid, jsonb) TO authenticated;

-- ============================================================================
-- 2e. Outlet-return provenance joins the common resource before document,
-- provenance and stock rows. The business/permission/JSON contract is the
-- latest 095 definition; only the leading advisory lock is new.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_add_outlet_return_request_line(
  p_return_request_id            uuid,
  p_original_dispatch_line_id    uuid DEFAULT NULL,
  p_requested_quantity           integer DEFAULT NULL,
  p_reason_code                  text DEFAULT NULL,
  p_reason_text                  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_request      public.outlet_return_requests%ROWTYPE;
  v_dispatch     public.warehouse_dispatch_lines%ROWTYPE;
  v_movement     public.outlet_stock_movements%ROWTYPE;
  v_stock        public.outlet_stock%ROWTYPE;
  v_reason_text  text := NULLIF(btrim(p_reason_text), '');
  v_line         public.outlet_return_request_lines%ROWTYPE;
  v_cap          integer;
  v_available    integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL THEN
    RAISE EXCEPTION 'return_request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_original_dispatch_line_id IS NULL THEN
    RAISE EXCEPTION 'original_dispatch_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_requested_quantity IS NULL OR p_requested_quantity <= 0 THEN
    RAISE EXCEPTION 'requested_quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF p_reason_code IS NULL OR p_reason_code NOT IN (
    'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',
    'recalled', 'quality_issue', 'temperature_excursion', 'other'
  ) THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '23514';
  END IF;

  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_provline:' || p_original_dispatch_line_id::text
  ]);

  SELECT * INTO v_request
  FROM public.outlet_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'return_request_not_editable' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.return_request', v_request.source_organization_id,
    NULL, v_request.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_return_request' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatch_lines WHERE id = p_original_dispatch_line_id FOR UPDATE;
  IF NOT FOUND OR v_dispatch.organization_id <> v_request.source_organization_id THEN
    RAISE EXCEPTION 'original_dispatch_line_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_dispatch.status NOT IN ('accepted', 'accepted_with_difference')
     OR v_dispatch.resulting_outlet_stock_id IS NULL THEN
    RAISE EXCEPTION 'original_dispatch_line_not_a_completed_receipt' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_stock
  FROM public.outlet_stock WHERE id = v_dispatch.resulting_outlet_stock_id FOR UPDATE;
  IF NOT FOUND OR v_stock.distribution_point_id <> v_request.distribution_point_id THEN
    RAISE EXCEPTION 'original_dispatch_line_not_at_this_outlet' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_movement
  FROM public.outlet_stock_movements
  WHERE dispatch_line_id = v_dispatch.id
    AND movement_type = 'dispatch_receive'
    AND outlet_stock_id = v_stock.id
    AND organization_id = v_request.source_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_receive_movement_not_found_for_line' USING ERRCODE = 'P0002';
  END IF;

  IF v_dispatch.scientific_name IS DISTINCT FROM v_stock.scientific_name
     OR COALESCE(v_dispatch.concentration,'') IS DISTINCT FROM COALESCE(v_stock.concentration,'')
     OR COALESCE(v_dispatch.dosage_form,'')   IS DISTINCT FROM COALESCE(v_stock.dosage_form,'')
     OR COALESCE(v_dispatch.national_code,'') IS DISTINCT FROM COALESCE(v_stock.national_code,'')
     OR COALESCE(v_dispatch.batch_number,'')  IS DISTINCT FROM COALESCE(v_stock.batch_number,'')
     OR COALESCE(v_dispatch.internal_batch_reference,'') IS DISTINCT FROM COALESCE(v_stock.internal_batch_reference,'')
     OR v_dispatch.expiry_date IS DISTINCT FROM v_stock.expiry_date THEN
    RAISE EXCEPTION 'provenance_material_batch_expiry_mismatch' USING ERRCODE = '23514';
  END IF;

  v_cap := COALESCE(v_dispatch.received_quantity, 0) - v_dispatch.returned_quantity;
  IF p_requested_quantity > v_cap THEN
    RAISE EXCEPTION 'requested_quantity_exceeds_returnable_cap' USING ERRCODE = '23514';
  END IF;

  v_available := COALESCE(v_stock.on_hand_quantity, 0) - COALESCE(v_stock.reserved_quantity, 0);
  IF p_requested_quantity > v_available THEN
    RAISE EXCEPTION 'requested_quantity_exceeds_current_availability' USING ERRCODE = '23514',
      DETAIL = format('requested %s, currently available %s (on_hand - reserved)',
                       p_requested_quantity, v_available);
  END IF;

  INSERT INTO public.outlet_return_request_lines (
    return_request_id, source_organization_id,
    original_dispatch_line_id, original_inbound_movement_id,
    original_inbound_movement_type, source_outlet_stock_id,
    scientific_name, concentration, dosage_form, unit, national_code,
    batch_number, internal_batch_reference, expiry_date,
    reason_code, reason_text, requested_quantity
  ) VALUES (
    p_return_request_id, v_request.source_organization_id,
    v_dispatch.id, v_movement.id,
    'dispatch_receive', v_stock.id,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date,
    p_reason_code, v_reason_text, p_requested_quantity
  )
  RETURNING * INTO v_line;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.source_organization_id, v_actor, v_actor_role,
    'outlet_stock.return_line_added', 'outlet_return_request_lines', v_line.id, v_line.scientific_name,
    jsonb_build_object(
      'return_request_id', p_return_request_id,
      'original_dispatch_line_id', v_dispatch.id,
      'original_inbound_movement_id', v_movement.id,
      'source_outlet_stock_id', v_stock.id,
      'reason_code', p_reason_code,
      'requested_quantity', p_requested_quantity
    )
  );

  RETURN jsonb_build_object('ok', true, 'return_request_line_id', v_line.id);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_add_outlet_return_request_line(uuid, uuid, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_add_outlet_return_request_line(uuid, uuid, integer, text, text) TO authenticated;

-- ============================================================================
-- 2f. Suggestion guard: provenance advisory/row precedes stock advisory/row.
-- Legal suggestion writers already hold inv_suggest org locks before DML.
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

    SELECT COALESCE(SUM(s.suggested_quantity), 0) INTO v_committed
    FROM public.inventory_transfer_suggestions s
    WHERE s.source_stock_id = NEW.source_stock_id
      AND s.status IN ('open', 'accepted')
      AND s.id <> NEW.id;
    IF v_committed + NEW.suggested_quantity > v_available THEN
      RAISE EXCEPTION 'guard_072_batch_oversubscribed';
    END IF;

    IF NEW.route_kind = 'outlet_to_warehouse' THEN
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
    ) THEN RAISE EXCEPTION 'guard_072_exchange_request_mismatch'; END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_suggestion_guard ON public.inventory_transfer_suggestions;
CREATE TRIGGER inventory_suggestion_guard
  BEFORE INSERT OR UPDATE ON public.inventory_transfer_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_inventory_suggestion_guard();

-- ============================================================================
-- 3. THE BRIDGE — one suggestion, full re-verification, one real draft.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_create_transfer_draft_from_suggestion(
  p_suggestion_id    uuid,
  p_document_number  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor               uuid := auth.uid();
  v_doc                 text := NULLIF(btrim(p_document_number), '');
  v_s                   public.inventory_transfer_suggestions%ROWTYPE;
  v_initial_source_org  uuid;
  v_initial_target_org  uuid;
  v_policy_minutes      integer;
  v_src_key             text;
  v_tgt_key             text;
  v_src_threshold_key   text;
  v_tgt_threshold_key   text;
  v_lock_a              text;
  v_lock_b              text;
  v_src_pos             record;
  v_tgt_pos             record;
  v_headroom            integer;
  v_deficit             integer;
  v_batch_available     integer;
  v_batch_committed     integer;
  v_batch_remaining     integer;
  v_returnable          integer;
  v_eligible            integer;
  v_src_central_item_id uuid;
  v_src_concentration   text;
  v_src_dosage_form     text;
  v_src_unit            text;
  v_src_scientific_name text;
  v_create_result       jsonb;
  v_request_id          uuid;
  v_dispatch_id         uuid;
  v_return_request_id   uuid;
  r                     record;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_doc IS NULL THEN RAISE EXCEPTION 'document_number_required'; END IF;

  -- Read only enough identity to join the same inv_suggest lock domain used
  -- by both legal suggestion generators. Direct table writes are REVOKEd.
  SELECT * INTO v_s FROM public.inventory_transfer_suggestions WHERE id = p_suggestion_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found'; END IF;
  v_initial_source_org := v_s.source_organization_id;
  v_initial_target_org := v_s.target_organization_id;

  v_lock_a := LEAST(v_initial_source_org::text, v_initial_target_org::text);
  v_lock_b := GREATEST(v_initial_source_org::text, v_initial_target_org::text);
  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_suggest:' || v_lock_a,
    'inv_suggest:' || v_lock_b
  ]);

  -- Re-read under the row lock only after joining the generator lock domain.
  -- A corridor identity change between the optimistic read and this lock is
  -- failed closed; the caller can retry from the new stable identity.
  SELECT * INTO v_s FROM public.inventory_transfer_suggestions WHERE id = p_suggestion_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found'; END IF;
  IF v_s.source_organization_id IS DISTINCT FROM v_initial_source_org
     OR v_s.target_organization_id IS DISTINCT FROM v_initial_target_org THEN
    RAISE EXCEPTION 'suggestion_changed_retry';
  END IF;

  -- Idempotent replay: the SAME actor re-submitting an already-drafted
  -- suggestion (e.g. after a client-side timeout on an already-committed
  -- call) gets the same result back instead of an error. A DIFFERENT actor
  -- retrying a suggestion someone else already drafted is refused.
  IF v_s.status = 'accepted' THEN
    IF v_s.accepted_by = v_actor THEN
      RETURN jsonb_build_object(
        'ok', true, 'suggestion_id', v_s.id, 'idempotent_replay', true,
        'route_kind', v_s.route_kind, 'quantity', v_s.suggested_quantity,
        'document_number', v_s.draft_document_number,
        'warehouse_transfer_request_id', v_s.draft_warehouse_transfer_request_id,
        'warehouse_dispatch_id', v_s.draft_warehouse_dispatch_id,
        'outlet_return_request_id', v_s.draft_outlet_return_request_id
      );
    END IF;
    RAISE EXCEPTION 'suggestion_already_drafted';
  END IF;
  IF v_s.status <> 'open' THEN RAISE EXCEPTION 'suggestion_not_open'; END IF;

  -- Gate 1 of 2: caller may interact with the suggestion queue at either
  -- endpoint (same permission phoenix_reject_inventory_transfer_suggestion
  -- already uses). This is NOT sufficient authority to create the real
  -- document — gate 2 is enforced by delegation below.
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
  FROM public.inventory_suggestion_policy WHERE organization_id = v_s.source_organization_id;
  IF v_s.last_validated_at < now() - make_interval(mins => COALESCE(v_policy_minutes, 30)) THEN
    RAISE EXCEPTION 'suggestion_stale_revalidate_required';
  END IF;

  -- Canonical, direction-neutral position keys. There is deliberately no
  -- src:/tgt: component: the same physical position receives the same key in
  -- either direction. Threshold keys intentionally omit scope_id and code so
  -- default/specific and coded/wildcard changes share one material guardian.
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

  -- Provenance is the first shared outlet-return resource. The add-line RPC
  -- and the guard below take this exact key before provenance/stock rows.
  IF v_s.route_kind = 'outlet_to_warehouse' THEN
    PERFORM public._phoenix_lock_inventory_resources(ARRAY[
      'inv_provline:' || v_s.provenance_dispatch_line_id::text
    ]);
  END IF;
  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    v_src_key, v_tgt_key, v_src_threshold_key, v_tgt_threshold_key
  ]);

  -- Lock provenance before stock, matching phoenix_add_outlet_return_request_line.
  IF v_s.route_kind = 'outlet_to_warehouse' THEN
    PERFORM 1
    FROM public.warehouse_dispatch_lines wdl
    WHERE wdl.id = v_s.provenance_dispatch_line_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'suggestion_no_longer_available: provenance_gone';
    END IF;
  END IF;

  -- Scope anchors are direction-neutral gap guardians. A concurrent stock
  -- INSERT must take KEY SHARE on the same parent through the existing
  -- composite FK; FOR UPDATE therefore serializes the missing-row/new-batch
  -- case before either side takes a stock row lock.
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

  -- Pre-lock every currently relevant stock row across BOTH positions in one
  -- global order. The later live helper re-locks these rows reentrantly while
  -- applying its unchanged coded/wildcard aggregation rule.
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

  -- ── FULL re-verification, LIVE — CROSS-ORG-IDOR-148-FIX sibling ──────────
  -- headroom/deficit are now derived from warehouse_stock/outlet_stock +
  -- inventory_signal_thresholds directly, via
  -- _phoenix_live_suggestion_scope_position, under the row locks that
  -- function takes — NEVER from inventory_alerts.observed_available/
  -- threshold_*, which is only as fresh as the last manual
  -- phoenix_recompute_inventory_alerts call and carries no lock of its own.
  SELECT * INTO v_src_pos FROM public._phoenix_live_suggestion_scope_position(
    v_s.source_organization_id, v_s.source_scope_kind, v_s.source_scope_id,
    v_s.scientific_name, v_s.national_code);
  SELECT * INTO v_tgt_pos FROM public._phoenix_live_suggestion_scope_position(
    v_s.target_organization_id, v_s.target_scope_kind, v_s.target_scope_id,
    v_s.scientific_name, v_s.national_code);

  -- Source surplus (live), minus every OTHER open/accepted suggestion drawing
  -- on the same source scope+material.
  v_headroom := GREATEST(COALESCE(v_src_pos.live_available, 0) - COALESCE(v_src_pos.target_max, 0), 0);
  IF v_headroom <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: no_source_surplus';
  END IF;
  v_headroom := v_headroom - COALESCE((
    SELECT SUM(s.suggested_quantity) FROM public.inventory_transfer_suggestions s
    WHERE s.source_scope_kind = v_s.source_scope_kind AND s.source_scope_id = v_s.source_scope_id
      AND s.source_organization_id = v_s.source_organization_id
      AND lower(s.scientific_name) = lower(v_s.scientific_name)
      AND s.national_code IS NOT DISTINCT FROM v_s.national_code
      AND s.status IN ('open', 'accepted') AND s.id <> v_s.id
  ), 0);
  IF v_headroom <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: source_surplus_committed';
  END IF;

  -- Target deficit (live), minus every OTHER open/accepted suggestion.
  -- GREATEST(..., 0) — never GREATEST(..., 1): a genuinely satisfied target
  -- (reorder_point <= live_available) must be refused, not floored to a
  -- spurious 1-unit deficit.
  v_deficit := GREATEST(COALESCE(v_tgt_pos.reorder_point, 0) - COALESCE(v_tgt_pos.live_available, 0), 0);
  IF v_deficit <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: no_target_shortfall';
  END IF;
  v_deficit := v_deficit - COALESCE((
    SELECT SUM(s.suggested_quantity) FROM public.inventory_transfer_suggestions s
    WHERE s.target_scope_kind = v_s.target_scope_kind AND s.target_scope_id = v_s.target_scope_id
      AND s.target_organization_id = v_s.target_organization_id
      AND lower(s.scientific_name) = lower(v_s.scientific_name)
      AND s.national_code IS NOT DISTINCT FROM v_s.national_code
      AND s.status IN ('open', 'accepted') AND s.id <> v_s.id
  ), 0);
  IF v_deficit <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: target_shortfall_committed';
  END IF;

  -- Batch: live availability, FRESH identity read (this doubles as the
  -- identity re-check — every field handed to the downstream add-line RPC
  -- below is read here, live, never copied from a possibly-stale snapshot on
  -- the suggestion row itself), unexpired, still matching org/scope/material.
  IF v_s.source_scope_kind = 'warehouse' THEN
    SELECT ws.available_quantity, ws.central_item_id, ws.concentration, ws.dosage_form,
           ws.unit, ws.scientific_name
      INTO v_batch_available, v_src_central_item_id, v_src_concentration, v_src_dosage_form,
           v_src_unit, v_src_scientific_name
    FROM public.warehouse_stock ws
    WHERE ws.id = v_s.source_stock_id
      AND ws.warehouse_id = v_s.source_scope_id
      AND ws.organization_id = v_s.source_organization_id
      AND lower(ws.scientific_name) = lower(v_s.scientific_name)
      AND (v_s.national_code IS NULL OR ws.national_code = v_s.national_code)
      AND (ws.expiry_date IS NULL OR ws.expiry_date >= current_date)
    FOR UPDATE;
  ELSE
    SELECT os.available_quantity, os.central_item_id, os.concentration, os.dosage_form,
           os.unit, os.scientific_name
      INTO v_batch_available, v_src_central_item_id, v_src_concentration, v_src_dosage_form,
           v_src_unit, v_src_scientific_name
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

  v_batch_committed := COALESCE((
    SELECT SUM(s.suggested_quantity) FROM public.inventory_transfer_suggestions s
    WHERE s.source_stock_id = v_s.source_stock_id AND s.status IN ('open', 'accepted') AND s.id <> v_s.id
  ), 0);
  v_batch_remaining := v_batch_available - v_batch_committed;

  IF v_s.route_kind = 'outlet_to_warehouse' THEN
    SELECT COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity INTO v_returnable
    FROM public.warehouse_dispatch_lines wdl
    WHERE wdl.id = v_s.provenance_dispatch_line_id
      AND wdl.status IN ('accepted', 'accepted_with_difference')
    FOR SHARE;
    IF v_returnable IS NULL THEN
      RAISE EXCEPTION 'suggestion_no_longer_available: provenance_gone';
    END IF;
    v_batch_remaining := LEAST(v_batch_remaining, v_returnable - COALESCE((
      SELECT SUM(s.suggested_quantity) FROM public.inventory_transfer_suggestions s
      WHERE s.provenance_dispatch_line_id = v_s.provenance_dispatch_line_id
        AND s.status IN ('open', 'accepted') AND s.id <> v_s.id
    ), 0));
  END IF;

  -- Final quantity: never exceeds what the reviewer was shown, and never
  -- exceeds any live constraint just re-derived above.
  v_eligible := LEAST(v_s.suggested_quantity, v_headroom, v_deficit, v_batch_remaining);
  IF v_eligible IS NULL OR v_eligible <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: eligible_quantity_zero';
  END IF;

  -- ── Delegate document creation to the EXISTING, already-permission-
  -- checked RPCs for the real corridor. auth.uid() is unaffected by nested
  -- SECURITY DEFINER calls, so each callee's own internal route-specific
  -- permission check (warehouse_transfer.send / warehouse_dispatch.create /
  -- outlet_stock.return_request) runs for real against this same actor —
  -- inventory.act_on_suggestions above is a queue gate, not a substitute for
  -- it, and a missing route permission fails this whole call closed.
  IF v_s.route_kind = 'central_to_institution' THEN
    v_create_result := public.phoenix_create_direct_warehouse_transfer_request(
      v_s.source_scope_id, v_s.target_organization_id, v_s.target_scope_id, v_doc,
      'Auto-drafted from inventory suggestion ' || v_s.id::text);
    v_request_id := (v_create_result->>'transfer_request_id')::uuid;
    PERFORM public.phoenix_add_warehouse_transfer_request_line(
      v_request_id, v_src_scientific_name, v_eligible, v_src_central_item_id,
      v_src_concentration, v_src_dosage_form, v_src_unit, NULL);

  ELSIF v_s.route_kind = 'warehouse_to_outlet' THEN
    v_create_result := public.phoenix_create_warehouse_dispatch(
      v_s.source_scope_id, v_s.target_scope_id, v_doc, NULL, NULL, NULL);
    v_dispatch_id := (v_create_result->>'dispatch_id')::uuid;
    PERFORM public.phoenix_add_dispatch_line_fefo_guarded(
      v_dispatch_id, v_s.source_stock_id, v_eligible, false, NULL, p_suggestion_id);

  ELSIF v_s.route_kind = 'outlet_to_warehouse' THEN
    v_create_result := public.phoenix_request_outlet_return(
      v_s.source_scope_id, v_doc, 'Auto-drafted from inventory suggestion ' || v_s.id::text);
    v_return_request_id := (v_create_result->>'return_request_id')::uuid;
    PERFORM public.phoenix_add_outlet_return_request_line(
      v_return_request_id, v_s.provenance_dispatch_line_id, v_eligible,
      'excess', 'Auto-drafted from inventory suggestion ' || v_s.id::text);

  ELSE
    RAISE EXCEPTION 'unsupported_route_kind: %', v_s.route_kind;
  END IF;

  UPDATE public.inventory_transfer_suggestions
  SET status = 'accepted',
      accepted_at = now(),
      accepted_by = v_actor,
      draft_document_number = v_doc,
      draft_warehouse_transfer_request_id = v_request_id,
      draft_warehouse_dispatch_id = v_dispatch_id,
      draft_outlet_return_request_id = v_return_request_id,
      suggested_quantity = v_eligible,
      updated_at = now()
  WHERE id = p_suggestion_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_s.target_organization_id, v_actor, public.phoenix_my_role(), 'update', 'inventory_transfer_suggestion',
          p_suggestion_id, v_s.route_kind || ':' || v_s.scientific_name,
          jsonb_build_object('lifecycle', 'draft_created', 'document_number', v_doc,
                              'quantity', v_eligible, 'route_kind', v_s.route_kind));

  RETURN jsonb_build_object(
    'ok', true, 'suggestion_id', p_suggestion_id, 'status', 'accepted', 'quantity', v_eligible,
    'route_kind', v_s.route_kind, 'document_number', v_doc,
    'warehouse_transfer_request_id', v_request_id,
    'warehouse_dispatch_id', v_dispatch_id,
    'outlet_return_request_id', v_return_request_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_create_transfer_draft_from_suggestion(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_create_transfer_draft_from_suggestion(uuid, text) TO authenticated;

-- ============================================================================
-- 4. REAL PAGINATION for 036/039 discovery alerts (peer-institution, always
--    executable=false — see header of this migration and the plan doc for
--    why no execution corridor exists for this route today).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state_page(
  p_limit  integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_full   jsonb;
  v_all    jsonb;
  v_total  integer;
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_page   jsonb;
BEGIN
  -- Reuses the existing discovery query UNCHANGED, at its own safety ceiling
  -- (500), so pagination never requires a second copy of the cross-org
  -- matching logic. 500 is this feed's real universe cap by design (036/037/
  -- 039 have always capped at 500) — this wrapper makes that ceiling honest
  -- with a real total_count instead of a silent truncation at 200.
  v_full := public.phoenix_get_live_inter_institution_alerts_with_state(500);
  IF NOT COALESCE((v_full->>'ok')::boolean, false) THEN
    RETURN v_full;
  END IF;
  v_all := COALESCE(v_full->'alerts', '[]'::jsonb);
  v_total := jsonb_array_length(v_all);

  SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
    INTO v_page
  FROM (
    SELECT (elem || jsonb_build_object('executable', false)) AS elem, ord
    FROM jsonb_array_elements(v_all) WITH ORDINALITY AS t(elem, ord)
    WHERE ord > v_offset AND ord <= v_offset + v_limit
  ) x;

  RETURN jsonb_build_object(
    'ok', true,
    'alerts', v_page,
    'total_count', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'computed_at', v_full->'computed_at'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state_page(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state_page(integer, integer) TO authenticated;

-- ============================================================================
-- 5. SELF-CHECK
-- ============================================================================
DO $selfcheck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_suggestions_draft_fk_matches_route_chk'
  ) THEN
    RAISE EXCEPTION 'ABORT 148: inventory_suggestions_draft_fk_matches_route_chk was not created.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_suggestions_no_accept_chk'
  ) THEN
    RAISE EXCEPTION 'ABORT 148: inventory_suggestions_no_accept_chk was not dropped.';
  END IF;
  IF to_regprocedure('public.phoenix_accept_inventory_transfer_suggestion(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT 148: the old accept stub still exists.';
  END IF;
  IF to_regprocedure('public.phoenix_create_transfer_draft_from_suggestion(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 148: phoenix_create_transfer_draft_from_suggestion was not created.';
  END IF;
  IF to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 148: the paginated alerts RPC was not created.';
  END IF;
  IF to_regclass('public.inventory_suggestion_policy') IS NULL THEN
    RAISE EXCEPTION 'ABORT 148: inventory_suggestion_policy was not created.';
  END IF;
  IF has_table_privilege('anon', 'public.inventory_suggestion_policy', 'SELECT') THEN
    RAISE EXCEPTION 'ABORT 148: anon can read inventory_suggestion_policy.';
  END IF;
  -- LIVE-BALANCE-FIX-148
  IF to_regprocedure('public._phoenix_live_suggestion_scope_position(uuid,text,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 148: _phoenix_live_suggestion_scope_position was not created.';
  END IF;
  IF to_regprocedure('public._phoenix_lock_inventory_resources(text[])') IS NULL THEN
    RAISE EXCEPTION 'ABORT 148: _phoenix_lock_inventory_resources was not created.';
  END IF;
  IF has_function_privilege('anon', 'public._phoenix_live_suggestion_scope_position(uuid,text,uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._phoenix_live_suggestion_scope_position(uuid,text,uuid,text,text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'ABORT 148: _phoenix_live_suggestion_scope_position is directly callable by anon/authenticated.';
  END IF;
  IF has_function_privilege('anon', 'public._phoenix_lock_inventory_resources(text[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._phoenix_lock_inventory_resources(text[])', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'ABORT 148: _phoenix_lock_inventory_resources is directly callable by anon/authenticated.';
  END IF;
END;
$selfcheck$;

COMMIT;
