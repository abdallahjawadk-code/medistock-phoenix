-- ============================================================================
-- MEDISTOCK PHOENIX — DELEGATED OPERATIONAL ACCESS — 187
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or an automated Production
-- runner. This migration is additive beside profile_scope_assignments: the
-- primary same-organization and Health-Center facility models are untouched.
--
-- Authorization remains WHAT + WHERE. An effective permission without a valid
-- scope is denied; a delegated scope without an effective permission is denied.
-- Future permission keys are denied until an exact row is reviewed forward.
-- ============================================================================

BEGIN;

DO $precondition$
BEGIN
  IF to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '187 PRECONDITION FAILED: central scoped-permission helper missing';
  END IF;
  IF to_regclass('public.profile_scope_assignments') IS NULL
     OR to_regprocedure('public.phoenix_admin_assign_facility_scopes(uuid,uuid,uuid[])') IS NULL THEN
    RAISE EXCEPTION '187 PRECONDITION FAILED: primary/facility scope model missing';
  END IF;
  IF to_regclass('public.profile_delegated_scope_assignments') IS NOT NULL
     OR to_regclass('public.delegated_operational_permission_keys') IS NOT NULL THEN
    RAISE EXCEPTION '187 PRECONDITION FAILED: delegated access objects already exist';
  END IF;
END;
$precondition$;

-- Exact, system-owned firewall. No prefix/module wildcard is consulted.
CREATE TABLE public.delegated_operational_permission_keys (
  permission_key       text PRIMARY KEY
    REFERENCES public.permission_keys(key) ON DELETE RESTRICT,
  reviewed_in_migration integer NOT NULL DEFAULT 187
    CHECK (reviewed_in_migration = 187),
  reviewed_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.delegated_operational_permission_keys(permission_key) VALUES
  ('inventory.act_on_suggestions'),
  ('inventory.fefo_override'),
  ('movement_context.record'),
  ('outlet_stock.count'),
  ('outlet_stock.dispense'),
  ('outlet_stock.recall'),
  ('outlet_stock.receive'),
  ('outlet_stock.replenish'),
  ('outlet_stock.replenish_reverse'),
  ('outlet_stock.resolve_return_exception'),
  ('outlet_stock.return'),
  ('outlet_stock.return_receive'),
  ('outlet_stock.return_request'),
  ('outlet_stock.review_return'),
  ('outlet_stock.view'),
  ('warehouse_dispatch.cancel'),
  ('warehouse_dispatch.create'),
  ('warehouse_dispatch.edit_draft'),
  ('warehouse_dispatch.send'),
  ('warehouse_dispatch.view'),
  ('warehouse_stock.adjust'),
  ('warehouse_stock.correct'),
  ('warehouse_stock.movements_view'),
  ('warehouse_stock.view'),
  ('warehouse_transfer.recall'),
  ('warehouse_transfer.receive'),
  ('warehouse_transfer.request'),
  ('warehouse_transfer.return_receive'),
  ('warehouse_transfer.return_request'),
  ('warehouse_transfer.return_send'),
  ('warehouse_transfer.review'),
  ('warehouse_transfer.review_return'),
  ('warehouse_transfer.send'),
  ('warehouse_transfer.view');

ALTER TABLE public.delegated_operational_permission_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.delegated_operational_permission_keys
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.profile_delegated_scope_assignments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id               uuid NOT NULL
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_organization_id   uuid NOT NULL
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  scope_type               text NOT NULL,
  warehouse_id             uuid,
  distribution_point_id    uuid,
  include_child_outlets    boolean NOT NULL DEFAULT false,
  grant_group_id           uuid NOT NULL,
  grant_origin             text NOT NULL,
  is_active                boolean NOT NULL DEFAULT true,
  assigned_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at              timestamptz NOT NULL DEFAULT now(),
  revoked_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at               timestamptz,
  revoke_reason            text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pdsa_warehouse_org_fk
    FOREIGN KEY (warehouse_id, target_organization_id)
    REFERENCES public.warehouses(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT pdsa_point_org_fk
    FOREIGN KEY (distribution_point_id, target_organization_id)
    REFERENCES public.distribution_points(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT pdsa_scope_type_chk
    CHECK (scope_type IN ('organization','warehouse','distribution_point')),
  CONSTRAINT pdsa_target_matches_scope_chk CHECK (
    CASE scope_type
      WHEN 'organization' THEN warehouse_id IS NULL
        AND distribution_point_id IS NULL AND include_child_outlets = false
      WHEN 'warehouse' THEN warehouse_id IS NOT NULL
        AND distribution_point_id IS NULL
      WHEN 'distribution_point' THEN distribution_point_id IS NOT NULL
        AND warehouse_id IS NULL AND include_child_outlets = false
      ELSE false
    END
  ),
  -- Only origins this migration actually emits. A future refresh mode must be
  -- introduced by its own reviewed migration rather than being pre-authorized
  -- here, so the idempotent-replay comparison below can never silently accept
  -- a mixed-origin set that no reviewer has seen.
  CONSTRAINT pdsa_grant_origin_chk
    CHECK (grant_origin IN ('direct','network_snapshot')),
  CONSTRAINT pdsa_status_chk CHECK (
    CASE WHEN is_active
      THEN revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL
      ELSE revoked_at IS NOT NULL AND revoke_reason IS NOT NULL
        AND btrim(revoke_reason) <> '' AND btrim(revoke_reason) = revoke_reason
    END
  ),
  CONSTRAINT pdsa_revoked_after_assigned_chk
    CHECK (revoked_at IS NULL OR revoked_at >= assigned_at)
);

CREATE UNIQUE INDEX pdsa_active_organization_uniq
  ON public.profile_delegated_scope_assignments(profile_id, target_organization_id)
  WHERE is_active AND scope_type = 'organization';
CREATE UNIQUE INDEX pdsa_active_warehouse_uniq
  ON public.profile_delegated_scope_assignments(profile_id, warehouse_id)
  WHERE is_active AND scope_type = 'warehouse';
CREATE UNIQUE INDEX pdsa_active_point_uniq
  ON public.profile_delegated_scope_assignments(profile_id, distribution_point_id)
  WHERE is_active AND scope_type = 'distribution_point';
CREATE INDEX pdsa_profile_active_idx
  ON public.profile_delegated_scope_assignments(profile_id, scope_type)
  WHERE is_active;
CREATE INDEX pdsa_target_org_idx
  ON public.profile_delegated_scope_assignments(target_organization_id)
  WHERE is_active;
CREATE INDEX pdsa_grant_group_idx
  ON public.profile_delegated_scope_assignments(grant_group_id);

CREATE TRIGGER set_profile_delegated_scope_assignments_updated_at
BEFORE UPDATE ON public.profile_delegated_scope_assignments
FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at();

ALTER TABLE public.profile_delegated_scope_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY pdsa_select_own_active_or_super
ON public.profile_delegated_scope_assignments FOR SELECT TO authenticated
USING (
  (profile_id = auth.uid() AND is_active)
  OR public.phoenix_my_role() = 'super_admin'
);

REVOKE ALL ON TABLE public.profile_delegated_scope_assignments
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.profile_delegated_scope_assignments TO authenticated;

-- CANONICAL delegated-recipient eligibility. Stated ONCE here and consulted by
-- every grant path, by the WHERE bridge and by the resource catalog, so no two
-- surfaces can drift apart.
--
-- A delegated recipient MUST have a PRIMARY ORGANIZATION ANCHOR. Delegation is
-- defined relative to that anchor: the direct grant refuses the recipient's own
-- organization and the network snapshot excludes it. A NULL organization_id has
-- nothing to refuse and nothing to exclude, so an unanchored profile would be
-- granted the ENTIRE network and the SECURITY DEFINER catalog would then fan
-- out over all of it. That is why NULL fails closed here rather than being
-- treated as "no organization to exclude".
CREATE FUNCTION public._phoenix_delegated_recipient_is_eligible_v1(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $delegated_recipient$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    JOIN public.organizations o
      ON o.id = p.organization_id AND o.status = 'active'
    WHERE p.id = p_profile_id
      AND p.status = 'active'
      AND p.organization_id IS NOT NULL
      AND p.role IN ('central_warehouse_manager','warehouse_officer','outlet_officer')
  );
$delegated_recipient$;

REVOKE ALL ON FUNCTION public._phoenix_delegated_recipient_is_eligible_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._phoenix_delegated_recipient_is_eligible_v1(uuid) IS
  'M187 canonical delegated-recipient eligibility: active profile, eligible operational role, and a NON-NULL primary organization that is itself active. Absence of a primary anchor is a denial.';

-- WHERE-only bridge. Permission classification deliberately lives outside it.
CREATE FUNCTION public._phoenix_profile_has_delegated_scope_v1(
  p_profile_id uuid,
  p_organization_id uuid,
  p_warehouse_id uuid DEFAULT NULL,
  p_distribution_point_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $delegated_scope$
  SELECT CASE
    WHEN p_profile_id IS NULL OR p_organization_id IS NULL THEN false
    WHEN p_warehouse_id IS NOT NULL AND p_distribution_point_id IS NOT NULL THEN false
    WHEN NOT public._phoenix_delegated_recipient_is_eligible_v1(p_profile_id) THEN false
    WHEN NOT EXISTS (
      SELECT 1 FROM public.organizations o
      WHERE o.id = p_organization_id AND o.status = 'active'
    ) THEN false
    WHEN p_warehouse_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.warehouses w
      WHERE w.id = p_warehouse_id AND w.organization_id = p_organization_id
        AND w.status = 'active'
    ) THEN false
    WHEN p_distribution_point_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.distribution_points d
      WHERE d.id = p_distribution_point_id
        AND d.organization_id = p_organization_id AND d.status = 'active'
    ) THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.profile_delegated_scope_assignments a
      WHERE a.profile_id = p_profile_id
        AND a.target_organization_id = p_organization_id
        AND a.is_active
        AND (
          a.scope_type = 'organization'
          OR (p_warehouse_id IS NOT NULL AND a.scope_type = 'warehouse'
              AND a.warehouse_id = p_warehouse_id)
          OR (p_distribution_point_id IS NOT NULL AND a.scope_type = 'distribution_point'
              AND a.distribution_point_id = p_distribution_point_id)
          OR (p_distribution_point_id IS NOT NULL AND a.scope_type = 'warehouse'
              AND a.include_child_outlets
              -- The PARENT warehouse must still be active. Every other branch
              -- re-derives liveness (organization above, warehouse at the
              -- direct-ask branch, point below); without this one, inheritance
              -- would outlive the topology it was scoped to. 183 deliberately
              -- permits deactivating a non-health-sector warehouse while its
              -- pharmacy outlets stay active (a pharmacy is legal with no
              -- owning warehouse at all), so the direct ask about THIS
              -- warehouse id would be refused while the inherited ask about
              -- its children was still allowed — the same row answering two
              -- ways about the same warehouse.
              AND EXISTS (
                SELECT 1 FROM public.warehouses parent
                WHERE parent.id = a.warehouse_id
                  AND parent.organization_id = p_organization_id
                  AND parent.status = 'active'
              )
              AND EXISTS (
                SELECT 1 FROM public.distribution_points child
                WHERE child.id = p_distribution_point_id
                  AND child.organization_id = p_organization_id
                  AND child.warehouse_id = a.warehouse_id
                  AND child.status = 'active'
              ))
        )
    )
  END;
$delegated_scope$;

REVOKE ALL ON FUNCTION public._phoenix_profile_has_delegated_scope_v1(uuid,uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Forward replacement of 182. The same-organization branch is preserved;
-- delegated access is a separate cross-organization branch only.
CREATE OR REPLACE FUNCTION public.phoenix_profile_has_scoped_permission(
  p_profile_id uuid,
  p_permission_key text,
  p_organization_id uuid DEFAULT NULL::uuid,
  p_warehouse_id uuid DEFAULT NULL::uuid,
  p_distribution_point_id uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $scoped_permission$
DECLARE
  v_role   text;
  v_status text;
  v_org    uuid;
  v_org_wide_roles text[] := ARRAY['institution_admin'];
BEGIN
  IF public.phoenix_my_role() = 'health_center_manager'
     AND p_profile_id IS DISTINCT FROM auth.uid() THEN
    RETURN false;
  END IF;

  IF p_profile_id IS NULL OR p_permission_key IS NULL OR btrim(p_permission_key) = '' THEN
    RETURN false;
  END IF;

  SELECT p.role, p.status, p.organization_id INTO v_role, v_status, v_org
  FROM public.profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND OR v_status IS DISTINCT FROM 'active' THEN RETURN false; END IF;
  IF v_role = 'super_admin' THEN RETURN true; END IF;
  IF p_warehouse_id IS NOT NULL AND p_distribution_point_id IS NOT NULL THEN RETURN false; END IF;
  IF v_org IS NULL OR p_organization_id IS NULL THEN RETURN false; END IF;

  -- Historical primary path, byte-for-behavior equivalent to Migration 182.
  IF p_organization_id IS NOT DISTINCT FROM v_org THEN
    IF NOT public.phoenix_profile_has_permission(p_profile_id, p_permission_key) THEN
      RETURN false;
    END IF;
    IF p_warehouse_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.warehouses w
        WHERE w.id=p_warehouse_id AND w.organization_id=p_organization_id
          AND w.status='active') THEN RETURN false; END IF;
      IF v_role = ANY(v_org_wide_roles) THEN RETURN true; END IF;
      RETURN public.phoenix_profile_has_warehouse_assignment(p_profile_id,p_warehouse_id);
    END IF;
    IF p_distribution_point_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.distribution_points d
        WHERE d.id=p_distribution_point_id AND d.organization_id=p_organization_id
          AND d.status='active') THEN RETURN false; END IF;
      IF v_role = ANY(v_org_wide_roles) THEN RETURN true; END IF;
      RETURN public.phoenix_profile_has_point_assignment(p_profile_id,p_distribution_point_id);
    END IF;
    RETURN v_role = ANY(v_org_wide_roles);
  END IF;

  -- Cross-organization path: exact eligible role + exact WHAT + exact WHERE.
  -- Authenticated callers may ask only about themselves; trusted internal
  -- callers have auth.uid() NULL and retain the historical explicit-profile API.
  IF auth.uid() IS NOT NULL AND p_profile_id IS DISTINCT FROM auth.uid() THEN
    RETURN false;
  END IF;
  IF v_role NOT IN ('central_warehouse_manager','warehouse_officer','outlet_officer') THEN
    RETURN false;
  END IF;
  IF NOT public.phoenix_profile_has_permission(p_profile_id, p_permission_key) THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.delegated_operational_permission_keys k
    WHERE k.permission_key = p_permission_key
  ) THEN
    RETURN false;
  END IF;
  RETURN public._phoenix_profile_has_delegated_scope_v1(
    p_profile_id,p_organization_id,p_warehouse_id,p_distribution_point_id);
END;
$scoped_permission$;

CREATE FUNCTION public.phoenix_admin_grant_delegated_scope(
  p_profile_id uuid,
  p_target_organization_id uuid,
  p_scope_type text,
  p_warehouse_id uuid DEFAULT NULL,
  p_distribution_point_id uuid DEFAULT NULL,
  p_include_child_outlets boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $grant_scope$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_target_role text;
  v_target_status text;
  v_target_primary_org uuid;
  v_id uuid;
  v_group uuid := gen_random_uuid();
  v_existing record;
BEGIN
  SELECT role INTO v_actor_role FROM public.profiles
  WHERE id=v_actor AND status='active';
  IF v_actor_role IS DISTINCT FROM 'super_admin'
     OR NOT public.phoenix_profile_has_permission(v_actor,'users.edit_scope') THEN
    RAISE EXCEPTION 'delegated_scope_request_denied' USING ERRCODE='42501';
  END IF;
  IF p_profile_id IS NULL OR p_target_organization_id IS NULL
     OR p_scope_type NOT IN ('organization','warehouse','distribution_point') THEN
    RAISE EXCEPTION 'invalid_delegated_scope_request' USING ERRCODE='23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_profile_id::text,187001));
  SELECT role,status,organization_id
    INTO v_target_role,v_target_status,v_target_primary_org
  FROM public.profiles WHERE id=p_profile_id FOR UPDATE;
  -- One canonical eligibility rule. It subsumes the active/role checks AND
  -- requires the primary-organization anchor, so a NULL-primary-org recipient
  -- is refused here — before any row, grant group or audit entry exists.
  IF NOT FOUND OR NOT public._phoenix_delegated_recipient_is_eligible_v1(p_profile_id) THEN
    RAISE EXCEPTION 'delegated_scope_recipient_ineligible' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o
    WHERE o.id=p_target_organization_id AND o.status='active') THEN
    RAISE EXCEPTION 'delegated_scope_request_denied' USING ERRCODE='42501';
  END IF;
  -- v_target_primary_org is guaranteed NON-NULL by the eligibility capsule, so
  -- this equality can no longer evaluate to NULL and silently fall through.
  IF p_target_organization_id = v_target_primary_org THEN
    RAISE EXCEPTION 'primary_scope_must_use_primary_model' USING ERRCODE='23514';
  END IF;

  IF p_scope_type='organization' THEN
    IF p_warehouse_id IS NOT NULL OR p_distribution_point_id IS NOT NULL
       OR p_include_child_outlets THEN
      RAISE EXCEPTION 'invalid_delegated_scope_shape' USING ERRCODE='23514';
    END IF;
  ELSIF p_scope_type='warehouse' THEN
    IF p_warehouse_id IS NULL OR p_distribution_point_id IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_delegated_scope_shape' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.warehouses w
      WHERE w.id=p_warehouse_id AND w.organization_id=p_target_organization_id
        AND w.status='active') THEN
      RAISE EXCEPTION 'delegated_scope_request_denied' USING ERRCODE='42501';
    END IF;
  ELSE
    IF p_distribution_point_id IS NULL OR p_warehouse_id IS NOT NULL
       OR p_include_child_outlets THEN
      RAISE EXCEPTION 'invalid_delegated_scope_shape' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.distribution_points d
      WHERE d.id=p_distribution_point_id
        AND d.organization_id=p_target_organization_id AND d.status='active') THEN
      RAISE EXCEPTION 'delegated_scope_request_denied' USING ERRCODE='42501';
    END IF;
  END IF;

  INSERT INTO public.profile_delegated_scope_assignments(
    profile_id,target_organization_id,scope_type,warehouse_id,
    distribution_point_id,include_child_outlets,grant_group_id,grant_origin,assigned_by)
  VALUES (p_profile_id,p_target_organization_id,p_scope_type,p_warehouse_id,
    p_distribution_point_id,p_include_child_outlets,v_group,'direct',v_actor)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id,include_child_outlets INTO v_existing
    FROM public.profile_delegated_scope_assignments a
    WHERE a.profile_id=p_profile_id AND a.is_active AND (
      (p_scope_type='organization' AND a.scope_type='organization'
        AND a.target_organization_id=p_target_organization_id)
      OR (p_scope_type='warehouse' AND a.scope_type='warehouse'
        AND a.warehouse_id=p_warehouse_id)
      OR (p_scope_type='distribution_point' AND a.scope_type='distribution_point'
        AND a.distribution_point_id=p_distribution_point_id))
    LIMIT 1;
    IF FOUND AND (p_scope_type <> 'warehouse'
       OR v_existing.include_child_outlets = p_include_child_outlets) THEN
      RETURN jsonb_build_object('ok',true,'assignment_id',v_existing.id,
        'idempotent_replay',true);
    END IF;
    RAISE EXCEPTION 'delegated_scope_active_conflict' USING ERRCODE='23514';
  END IF;

  INSERT INTO public.audit_logs(organization_id,actor_id,actor_role,action,entity_type,entity_id,payload)
  VALUES (p_target_organization_id,v_actor,v_actor_role,'delegated_scope_assigned',
    'profile_delegated_scope_assignment',v_id,jsonb_build_object(
      'profile_id',p_profile_id,'target_organization_id',p_target_organization_id,
      'scope_type',p_scope_type,'warehouse_id',p_warehouse_id,
      'distribution_point_id',p_distribution_point_id,
      'include_child_outlets',p_include_child_outlets,
      'grant_group_id',v_group,'grant_origin','direct'));

  RETURN jsonb_build_object('ok',true,'assignment_id',v_id,
    'grant_group_id',v_group,'idempotent_replay',false);
END;
$grant_scope$;

CREATE FUNCTION public.phoenix_admin_grant_delegated_network_snapshot(p_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $network_snapshot$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_target_role text;
  v_target_status text;
  v_target_primary_org uuid;
  v_group uuid := gen_random_uuid();
  v_org_id uuid;
  v_org_ids uuid[];
  v_id uuid;
  v_inserted integer := 0;
  v_current integer;
  v_existing integer;
  v_existing_groups integer;
  v_existing_group uuid;
BEGIN
  SELECT role INTO v_actor_role FROM public.profiles WHERE id=v_actor AND status='active';
  IF v_actor_role IS DISTINCT FROM 'super_admin'
     OR NOT public.phoenix_profile_has_permission(v_actor,'users.edit_scope') THEN
    RAISE EXCEPTION 'delegated_scope_request_denied' USING ERRCODE='42501';
  END IF;
  -- All grant modes for one recipient share one lock namespace.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_profile_id::text,187001));
  SELECT role,status,organization_id
    INTO v_target_role,v_target_status,v_target_primary_org
  FROM public.profiles WHERE id=p_profile_id FOR UPDATE;
  -- Same canonical rule as every other grant path. A recipient with no primary
  -- organization anchor is refused HERE, before the snapshot is materialized —
  -- otherwise `o.id IS DISTINCT FROM NULL` would exclude nothing and hand the
  -- recipient the entire current network.
  IF NOT FOUND OR NOT public._phoenix_delegated_recipient_is_eligible_v1(p_profile_id) THEN
    RAISE EXCEPTION 'delegated_scope_recipient_ineligible' USING ERRCODE='42501';
  END IF;

  -- Freeze topology writes for this short administrative transaction, then
  -- materialize the ordered active-ID snapshot once. Count, replay comparison,
  -- inserted rows and audit payloads all derive from this same set.
  --
  -- The recipient's OWN organization is excluded, exactly as the direct grant
  -- refuses it with primary_scope_must_use_primary_model. Delegation is the
  -- FOREIGN-organization model; a same-org row would be inert at the
  -- authorization helper (which takes the primary branch) yet would still make
  -- phoenix_my_operational_resource_catalog() fan out over every warehouse and
  -- outlet in the recipient's own organization — topology that wh_select_scoped
  -- deliberately withholds from these operational roles.
  LOCK TABLE public.organizations IN SHARE MODE;
  SELECT COALESCE(array_agg(o.id ORDER BY o.id),ARRAY[]::uuid[])
    INTO v_org_ids FROM public.organizations o
   WHERE o.status='active' AND o.id IS DISTINCT FROM v_target_primary_org;
  v_current := cardinality(v_org_ids);
  -- Probe the existing active set BEFORE the empty-snapshot early return.
  -- Now that the recipient's own organization is excluded, v_current can be
  -- zero while active delegated organization rows still exist (a single-
  -- organization deployment, or every foreign organization deactivated), and
  -- returning 'empty_snapshot' over a non-empty active set would misreport it.
  SELECT count(*)::integer,count(DISTINCT a.grant_group_id)::integer
    INTO v_existing,v_existing_groups
  FROM public.profile_delegated_scope_assignments a
  WHERE a.profile_id=p_profile_id AND a.is_active AND a.scope_type='organization';
  IF v_current=0 THEN
    IF v_existing > 0 THEN
      RAISE EXCEPTION 'delegated_network_snapshot_active_conflict' USING ERRCODE='23514';
    END IF;
    RETURN jsonb_build_object('ok',true,'grant_group_id',NULL,
      'organization_count',0,'assignments_created',0,
      'idempotent_replay',true,'empty_snapshot',true,
      'future_organizations_included',false);
  END IF;
  IF v_existing > 0 THEN
    IF v_existing=v_current AND v_existing_groups=1
       AND NOT EXISTS (
         SELECT 1 FROM unnest(v_org_ids) AS o(id)
         WHERE NOT EXISTS (
           SELECT 1 FROM public.profile_delegated_scope_assignments a
           WHERE a.profile_id=p_profile_id AND a.is_active
             AND a.scope_type='organization' AND a.target_organization_id=o.id
             AND a.grant_origin='network_snapshot'))
    THEN
      SELECT a.grant_group_id INTO v_existing_group
      FROM public.profile_delegated_scope_assignments a
      WHERE a.profile_id=p_profile_id AND a.is_active AND a.scope_type='organization'
      LIMIT 1;
      RETURN jsonb_build_object('ok',true,'grant_group_id',v_existing_group,
        'organization_count',v_current,'assignments_created',0,
        'idempotent_replay',true,'future_organizations_included',false);
    END IF;
    RAISE EXCEPTION 'delegated_network_snapshot_active_conflict' USING ERRCODE='23514';
  END IF;
  FOREACH v_org_id IN ARRAY v_org_ids LOOP
    INSERT INTO public.profile_delegated_scope_assignments(
      profile_id,target_organization_id,scope_type,include_child_outlets,
      grant_group_id,grant_origin,assigned_by)
    VALUES (p_profile_id,v_org_id,'organization',false,v_group,
      'network_snapshot',v_actor)
    ON CONFLICT DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      v_inserted := v_inserted + 1;
      INSERT INTO public.audit_logs(organization_id,actor_id,actor_role,action,entity_type,entity_id,payload)
      VALUES (v_org_id,v_actor,v_actor_role,'delegated_scope_assigned',
        'profile_delegated_scope_assignment',v_id,jsonb_build_object(
          'profile_id',p_profile_id,'target_organization_id',v_org_id,
          'scope_type','organization','include_child_outlets',false,
          'grant_group_id',v_group,'grant_origin','network_snapshot',
          'snapshot_organization_count',v_current));
    END IF;
    v_id := NULL;
  END LOOP;
  RETURN jsonb_build_object('ok',true,'grant_group_id',v_group,
    'organization_count',v_current,'assignments_created',v_inserted,
    'idempotent_replay',false,'future_organizations_included',false);
END;
$network_snapshot$;

CREATE FUNCTION public.phoenix_admin_revoke_delegated_scope(
  p_assignment_id uuid,
  p_grant_group_id uuid,
  p_revoke_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $revoke_scope$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_reason text := nullif(btrim(p_revoke_reason),'');
  v_row record;
  v_count integer := 0;
  v_profile_id uuid;
BEGIN
  SELECT role INTO v_actor_role FROM public.profiles WHERE id=v_actor AND status='active';
  IF v_actor_role IS DISTINCT FROM 'super_admin'
     OR NOT public.phoenix_profile_has_permission(v_actor,'users.edit_scope') THEN
    RAISE EXCEPTION 'delegated_scope_request_denied' USING ERRCODE='42501';
  END IF;
  IF (p_assignment_id IS NULL) = (p_grant_group_id IS NULL) OR v_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_delegated_scope_revoke' USING ERRCODE='23514';
  END IF;
  SELECT a.profile_id INTO v_profile_id
  FROM public.profile_delegated_scope_assignments a
  WHERE (p_assignment_id IS NOT NULL AND a.id=p_assignment_id)
     OR (p_grant_group_id IS NOT NULL AND a.grant_group_id=p_grant_group_id)
  LIMIT 1;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    coalesce(v_profile_id::text,p_assignment_id::text,p_grant_group_id::text),187001));

  FOR v_row IN
    UPDATE public.profile_delegated_scope_assignments a
    SET is_active=false,revoked_by=v_actor,revoked_at=now(),revoke_reason=v_reason
    WHERE a.is_active AND (
      (p_assignment_id IS NOT NULL AND a.id=p_assignment_id)
      OR (p_grant_group_id IS NOT NULL AND a.grant_group_id=p_grant_group_id))
    RETURNING a.*
  LOOP
    v_count := v_count + 1;
    INSERT INTO public.audit_logs(organization_id,actor_id,actor_role,action,entity_type,entity_id,payload)
    VALUES (v_row.target_organization_id,v_actor,v_actor_role,'delegated_scope_revoked',
      'profile_delegated_scope_assignment',v_row.id,jsonb_build_object(
        'profile_id',v_row.profile_id,'target_organization_id',v_row.target_organization_id,
        'scope_type',v_row.scope_type,'warehouse_id',v_row.warehouse_id,
        'distribution_point_id',v_row.distribution_point_id,
        'include_child_outlets',v_row.include_child_outlets,
        'grant_group_id',v_row.grant_group_id,'grant_origin',v_row.grant_origin,
        'revoke_reason',v_reason));
  END LOOP;
  RETURN jsonb_build_object('ok',true,'revoked_count',v_count,
    'already_inactive_or_absent',v_count=0);
END;
$revoke_scope$;

CREATE FUNCTION public.phoenix_list_delegated_scopes(
  p_profile_id uuid DEFAULT NULL,
  p_include_revoked boolean DEFAULT false
)
RETURNS TABLE(
  assignment_id uuid,
  profile_id uuid,
  target_organization_id uuid,
  organization_name text,
  organization_name_ar text,
  scope_type text,
  warehouse_id uuid,
  warehouse_name text,
  warehouse_name_ar text,
  distribution_point_id uuid,
  distribution_point_name text,
  distribution_point_name_ar text,
  parent_warehouse_id uuid,
  parent_warehouse_name text,
  parent_warehouse_name_ar text,
  include_child_outlets boolean,
  grant_group_id uuid,
  grant_origin text,
  is_active boolean,
  assigned_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $list_scopes$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_target uuid := coalesce(p_profile_id,auth.uid());
BEGIN
  SELECT p.role INTO v_role FROM public.profiles p
  WHERE p.id=v_actor AND p.status='active';
  IF v_actor IS NULL OR v_role IS NULL THEN RETURN; END IF;
  IF v_role <> 'super_admin' AND v_target IS DISTINCT FROM v_actor THEN RETURN; END IF;
  IF v_role <> 'super_admin' AND p_include_revoked THEN RETURN; END IF;

  RETURN QUERY
  SELECT a.id,a.profile_id,a.target_organization_id,o.name,o.name_ar,a.scope_type,
    a.warehouse_id,w.name,w.name_ar,a.distribution_point_id,d.name,d.name_ar,
    d.warehouse_id,pw.name,pw.name_ar,a.include_child_outlets,a.grant_group_id,
    a.grant_origin,a.is_active,a.assigned_at,a.revoked_at,a.revoke_reason
  FROM public.profile_delegated_scope_assignments a
  JOIN public.organizations o ON o.id=a.target_organization_id
  LEFT JOIN public.warehouses w ON w.id=a.warehouse_id
  LEFT JOIN public.distribution_points d ON d.id=a.distribution_point_id
  LEFT JOIN public.warehouses pw ON pw.id=d.warehouse_id
  WHERE a.profile_id=v_target AND (a.is_active OR p_include_revoked)
  ORDER BY a.is_active DESC,a.assigned_at DESC,a.id;
END;
$list_scopes$;

-- Scope-only projection for eligible operational actors. It never answers
-- WHAT; each server mutation still calls phoenix_profile_has_scoped_permission.
CREATE FUNCTION public.phoenix_my_operational_resource_catalog()
RETURNS TABLE(
  organization_id uuid,
  organization_name text,
  organization_name_ar text,
  warehouse_id uuid,
  warehouse_name text,
  warehouse_name_ar text,
  warehouse_kind text,
  warehouse_facility_id uuid,
  distribution_point_id uuid,
  distribution_point_name text,
  distribution_point_name_ar text,
  distribution_point_type text,
  scope_source text,
  include_child_outlets boolean
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $resource_catalog$
  -- DEFENCE IN DEPTH. This anchor is re-derived here rather than trusted from
  -- grant time: a legacy, hand-written or otherwise corrupt delegated row must
  -- still project NOTHING if the caller has no valid primary-organization
  -- anchor. Because every delegated branch below joins `me`, an unanchored
  -- caller yields an empty catalog without any branch needing its own guard.
  WITH me AS (
    SELECT p.id,p.organization_id,p.role FROM public.profiles p
    WHERE p.id=auth.uid() AND p.status='active'
      AND p.organization_id IS NOT NULL
      AND public._phoenix_delegated_recipient_is_eligible_v1(p.id)
  ), deleg AS (
    -- The FOREIGN-organization rule, stated ONCE for every delegated branch
    -- below rather than copied into each. A row whose target IS the caller's
    -- own organization is not delegation at all — it is the primary model —
    -- and projecting it here would fan the catalog out over the caller's
    -- ENTIRE own organization, exactly the topology the primary branches
    -- above deliberately withhold from these operational roles. Both grant
    -- paths already refuse such a row (direct:
    -- primary_scope_must_use_primary_model; snapshot: own-org exclusion), so
    -- this is DEFENCE IN DEPTH for a hand-written, legacy or corrupt row,
    -- exactly like the anchor re-derivation in `me`. Because every branch
    -- below reads from `deleg`, no branch can forget either rule.
    -- `<>`, NOT `IS DISTINCT FROM`. This is an INCLUSION conjunct, so the two
    -- operators differ in the direction that matters: on a NULL anchor
    -- IS DISTINCT FROM returns TRUE and would admit every delegated row (fail
    -- OPEN), while `<>` returns NULL and drops it (fail CLOSED). `me` already
    -- guarantees a non-NULL anchor, so the two are equivalent in practice and
    -- this is purely about which way the predicate breaks if that guarantee
    -- ever moves. Same rule as 182's `role <> ... OR <scope>` guards.
    SELECT a.*
    FROM me
    JOIN public.profile_delegated_scope_assignments a ON a.profile_id=me.id
    WHERE a.is_active
      AND a.target_organization_id <> me.organization_id
  ), rows AS (
    SELECT o.id organization_id,o.name organization_name,o.name_ar organization_name_ar,
      NULL::uuid warehouse_id,NULL::text warehouse_name,NULL::text warehouse_name_ar,
      NULL::text warehouse_kind,NULL::uuid warehouse_facility_id,
      NULL::uuid distribution_point_id,NULL::text distribution_point_name,
      NULL::text distribution_point_name_ar,NULL::text distribution_point_type,
      'primary'::text scope_source,false include_child_outlets
    FROM me JOIN public.organizations o ON o.id=me.organization_id AND o.status='active'

    UNION ALL
    SELECT o.id,o.name,o.name_ar,w.id,w.name,w.name_ar,w.warehouse_kind,w.facility_id,
      NULL::uuid,NULL::text,NULL::text,NULL::text,
      'primary',false
    FROM me JOIN public.profile_scope_assignments a ON a.profile_id=me.id
      AND a.is_active AND a.scope_type='warehouse'
    JOIN public.warehouses w ON w.id=a.warehouse_id AND w.status='active'
    JOIN public.organizations o ON o.id=w.organization_id AND o.status='active'

    UNION ALL
    SELECT o.id,o.name,o.name_ar,w.id,w.name,w.name_ar,w.warehouse_kind,w.facility_id,
      d.id,d.name,d.name_ar,d.point_type,
      'primary',false
    FROM me JOIN public.profile_scope_assignments a ON a.profile_id=me.id
      AND a.is_active AND a.scope_type='distribution_point'
    JOIN public.distribution_points d ON d.id=a.distribution_point_id AND d.status='active'
    LEFT JOIN public.warehouses w ON w.id=d.warehouse_id
    JOIN public.organizations o ON o.id=d.organization_id AND o.status='active'

    UNION ALL
    SELECT o.id,o.name,o.name_ar,NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::uuid,
      NULL::uuid,NULL::text,NULL::text,NULL::text,'delegated',false
    FROM deleg a
    JOIN public.organizations o ON o.id=a.target_organization_id AND o.status='active'
    WHERE a.scope_type='organization'

    UNION ALL
    SELECT o.id,o.name,o.name_ar,w.id,w.name,w.name_ar,w.warehouse_kind,w.facility_id,
      NULL::uuid,NULL::text,NULL::text,NULL::text,
      'delegated',a.include_child_outlets
    FROM deleg a
    JOIN public.warehouses w ON w.id=a.warehouse_id AND w.status='active'
    JOIN public.organizations o ON o.id=a.target_organization_id AND o.status='active'
    WHERE a.scope_type='warehouse'

    -- Child-outlet inheritance. `w` is the PARENT warehouse itself
    -- (w.id = a.warehouse_id = d.warehouse_id), joined with status='active' so
    -- this projection cannot outlive a deactivated parent — the same liveness
    -- rule the authorization helper's inheritance branch enforces. The sibling
    -- branch above already dropped the warehouse row in that state, so without
    -- this filter the catalog would hide the warehouse yet still list its
    -- outlets.
    UNION ALL
    SELECT o.id,o.name,o.name_ar,w.id,w.name,w.name_ar,w.warehouse_kind,w.facility_id,
      d.id,d.name,d.name_ar,d.point_type,
      'delegated',true
    FROM deleg a
    JOIN public.warehouses w ON w.id=a.warehouse_id AND w.status='active'
    JOIN public.distribution_points d ON d.warehouse_id=a.warehouse_id
      AND d.organization_id=a.target_organization_id AND d.status='active'
    JOIN public.organizations o ON o.id=a.target_organization_id AND o.status='active'
    WHERE a.scope_type='warehouse' AND a.include_child_outlets

    -- An exact point scope. The LEFT JOIN names the ancestry for the UI only:
    -- a point is legal with no owning warehouse, and this row never authorizes
    -- the parent (the helper requires scope_type='warehouse' for that).
    UNION ALL
    SELECT o.id,o.name,o.name_ar,w.id,w.name,w.name_ar,w.warehouse_kind,w.facility_id,
      d.id,d.name,d.name_ar,d.point_type,
      'delegated',false
    FROM deleg a
    JOIN public.distribution_points d ON d.id=a.distribution_point_id AND d.status='active'
    LEFT JOIN public.warehouses w ON w.id=d.warehouse_id
    JOIN public.organizations o ON o.id=a.target_organization_id AND o.status='active'
    WHERE a.scope_type='distribution_point'

    UNION ALL
    SELECT o.id,o.name,o.name_ar,w.id,w.name,w.name_ar,w.warehouse_kind,w.facility_id,
      NULL::uuid,NULL::text,NULL::text,NULL::text,
      'delegated',false
    FROM deleg a
    JOIN public.organizations o ON o.id=a.target_organization_id AND o.status='active'
    JOIN public.warehouses w ON w.organization_id=o.id AND w.status='active'
    WHERE a.scope_type='organization'

    UNION ALL
    SELECT o.id,o.name,o.name_ar,w.id,w.name,w.name_ar,w.warehouse_kind,w.facility_id,
      d.id,d.name,d.name_ar,d.point_type,
      'delegated',false
    FROM deleg a
    JOIN public.organizations o ON o.id=a.target_organization_id AND o.status='active'
    JOIN public.distribution_points d ON d.organization_id=o.id AND d.status='active'
    LEFT JOIN public.warehouses w ON w.id=d.warehouse_id
    WHERE a.scope_type='organization'
  )
  SELECT DISTINCT * FROM rows
  ORDER BY organization_name,warehouse_name NULLS FIRST,distribution_point_name NULLS FIRST;
$resource_catalog$;

-- READ SURFACE — STATED IN FULL, because the four policies below are NOT the
-- whole story and an approver must not be misled by their small number.
--
-- The four policies added here are the ones that NEEDED adding: their tables'
-- pre-existing policies carry their own organization-equality predicate, which
-- no delegated grant could satisfy, so a separate foreign-org path is required.
--
-- But phoenix_profile_has_scoped_permission (forward-replaced above) is the
-- authorization primitive behind many OTHER pre-existing SELECT policies that
-- carry NO organization predicate of their own — directly, or through the
-- phoenix_can_read_* helpers. Those policies become cross-organization for the
-- 34 allowlisted keys the moment this migration lands, without being touched.
-- That is the intended consequence of the model (each still demands an exact
-- allowlisted WHAT plus a matching delegated WHERE), but it is a far larger
-- disclosure than "four tables", so it is enumerated here and PINNED by a
-- dynamic census test that fails if the set ever changes:
--
--   WIDENED (20 tables) — outlet_stock, outlet_stock_movements,
--     outlet_return_requests(+_lines), outlet_return_shipments(+_lines),
--     warehouse_stock, warehouse_stock_movements,
--     warehouse_dispatches(+_lines), warehouse_transfers(+_lines),
--     warehouse_transfer_requests(+_lines),
--     warehouse_return_requests(+_lines), warehouse_return_shipments(+_lines),
--     warehouse_quarantine_stock, warehouse_quarantine_stock_movements
--
--   NOT WIDENED (11 tables) — inventory_alerts, inventory_signal_thresholds,
--     inventory_transfer_suggestions, phoenix_report_snapshots, and the SEVEN
--     procurement_* tables: their policies gate on keys (reports.view,
--     inventory.view_signals, local_procurement.view) that are deliberately
--     ABSENT from the delegated allowlist, so delegation cannot reach them.
--     Count the seventh carefully: procurement_suppliers reaches the primitive
--     through phoenix_procurement_org_authority, NOT through
--     phoenix_can_read_local_procurement, so enumerating the can_read_* call
--     sites alone yields six and silently drops it. The census test below
--     therefore follows EVERY function whose body calls the primitive, not
--     just the phoenix_can_read_* family.
--
-- An organization-scope row matches ANY warehouse or outlet in that
-- organization, so it confers breadth inside the foreign organization that the
-- same operational role does not hold in its own (where org-wide answers are
-- reserved to institution_admin). Grant it deliberately.
--
-- The four policies below keep the current same-org policies byte-for-behavior
-- (including historical rows whose warehouse is no longer active) and add a
-- separate permissive path only for a foreign delegated org.
DROP POLICY IF EXISTS "warehouse_stock_delegated_select" ON public.warehouse_stock;
CREATE POLICY "warehouse_stock_delegated_select" ON public.warehouse_stock
FOR SELECT TO authenticated USING (
  organization_id IS DISTINCT FROM public.phoenix_my_org()
  AND
  public.phoenix_profile_has_scoped_permission(
    auth.uid(),'warehouse_stock.view',organization_id,warehouse_id,NULL));

DROP POLICY IF EXISTS "warehouse_stock_mov_delegated_select" ON public.warehouse_stock_movements;
CREATE POLICY "warehouse_stock_mov_delegated_select" ON public.warehouse_stock_movements
FOR SELECT TO authenticated USING (
  organization_id IS DISTINCT FROM public.phoenix_my_org()
  AND
  public.phoenix_profile_has_scoped_permission(
    auth.uid(),'warehouse_stock.movements_view',organization_id,warehouse_id,NULL));

-- The same additive pattern preserves 091's institution-admin and archived-
-- warehouse history semantics. 070's restrictive composition remains intact.
DROP POLICY IF EXISTS "warehouse_dispatches_delegated_select" ON public.warehouse_dispatches;
CREATE POLICY "warehouse_dispatches_delegated_select" ON public.warehouse_dispatches
FOR SELECT TO authenticated USING (
  organization_id IS DISTINCT FROM public.phoenix_my_org()
  AND
  public.phoenix_profile_has_scoped_permission(
    auth.uid(),'warehouse_dispatch.view',organization_id,warehouse_id,NULL));

DROP POLICY IF EXISTS "warehouse_dispatch_lines_delegated_select" ON public.warehouse_dispatch_lines;
CREATE POLICY "warehouse_dispatch_lines_delegated_select" ON public.warehouse_dispatch_lines
FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.warehouse_dispatches d
    WHERE d.id=warehouse_dispatch_lines.dispatch_id
      AND d.organization_id IS DISTINCT FROM public.phoenix_my_org()
      AND public.phoenix_profile_has_scoped_permission(
        auth.uid(),'warehouse_dispatch.view',d.organization_id,d.warehouse_id,NULL)));

-- Canonical lifecycle tripwire. Enable never restores old authority; a new
-- explicit grant is required after disable, recycle, role change or org move.
CREATE FUNCTION public._phoenix_revoke_delegated_scopes_on_profile_lifecycle_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $lifecycle_revoke$
DECLARE
  v_reason text;
  v_actor uuid := auth.uid();
  v_actor_role text := public.phoenix_my_role();
  v_row record;
BEGIN
  IF TG_OP='DELETE' THEN
    v_reason := 'profile_deleted';
  ELSIF NEW.identity_version IS DISTINCT FROM OLD.identity_version THEN
    v_reason := 'identity_recycled';
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IS DISTINCT FROM 'active' THEN
    v_reason := 'profile_inactive';
  ELSIF NEW.role IS DISTINCT FROM OLD.role THEN
    v_reason := 'role_changed';
  ELSIF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    v_reason := 'primary_organization_changed';
  ELSE
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  FOR v_row IN
    UPDATE public.profile_delegated_scope_assignments a
    SET is_active=false,revoked_by=v_actor,revoked_at=now(),revoke_reason=v_reason
    WHERE a.profile_id=OLD.id AND a.is_active
    RETURNING a.*
  LOOP
    INSERT INTO public.audit_logs(organization_id,actor_id,actor_role,action,entity_type,entity_id,payload)
    VALUES (v_row.target_organization_id,v_actor,v_actor_role,'delegated_scope_revoked',
      'profile_delegated_scope_assignment',v_row.id,jsonb_build_object(
        'profile_id',OLD.id,'target_organization_id',v_row.target_organization_id,
        'scope_type',v_row.scope_type,'warehouse_id',v_row.warehouse_id,
        'distribution_point_id',v_row.distribution_point_id,
        'include_child_outlets',v_row.include_child_outlets,
        'grant_group_id',v_row.grant_group_id,'grant_origin',v_row.grant_origin,
        'revoke_reason',v_reason,'lifecycle',true));
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$lifecycle_revoke$;

REVOKE ALL ON FUNCTION public._phoenix_revoke_delegated_scopes_on_profile_lifecycle_v1()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER revoke_delegated_scopes_on_profile_lifecycle
BEFORE UPDATE OF status,role,organization_id,identity_version OR DELETE
ON public.profiles FOR EACH ROW
EXECUTE FUNCTION public._phoenix_revoke_delegated_scopes_on_profile_lifecycle_v1();

-- M185 outlet recall seam: same-org retains the historical owning-warehouse
-- check; cross-org names the derived outlet point so child inheritance cannot
-- be bypassed when include_child_outlets=false.
CREATE OR REPLACE FUNCTION public.phoenix_recall_outlet_inbound_movement(
  p_original_inbound_movement_id uuid,
  p_return_number text,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $outlet_recall$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_actor_org uuid;
  v_number text := NULLIF(btrim(p_return_number),'');
  v_notes text := NULLIF(btrim(p_notes),'');
  v_move public.outlet_stock_movements%ROWTYPE;
  v_stock public.outlet_stock%ROWTYPE;
  v_point public.distribution_points%ROWTYPE;
  v_res jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000'; END IF;
  IF p_original_inbound_movement_id IS NULL THEN
    RAISE EXCEPTION 'original_inbound_movement_id_required' USING ERRCODE='23514';
  END IF;
  IF v_number IS NULL THEN RAISE EXCEPTION 'return_number_required' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_original_inbound_movement_id::text||'|'||v_number,185003));

  SELECT * INTO v_move FROM public.outlet_stock_movements
  WHERE id=p_original_inbound_movement_id;
  IF NOT FOUND OR v_move.movement_type<>'dispatch_receive'
     OR v_move.dispatch_line_id IS NULL THEN
    RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_stock FROM public.outlet_stock WHERE id=v_move.outlet_stock_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_point FROM public.distribution_points
  WHERE id=v_stock.distribution_point_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE='42501'; END IF;

  SELECT p.role,p.organization_id INTO v_actor_role,v_actor_org
  FROM public.profiles p WHERE p.id=v_actor AND p.status='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE='42501'; END IF;

  IF v_point.organization_id IS NOT DISTINCT FROM v_actor_org THEN
    IF NOT public.phoenix_profile_has_scoped_permission(
      v_actor,'outlet_stock.recall',v_point.organization_id,v_point.warehouse_id,NULL) THEN
      RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE='42501';
    END IF;
  ELSE
    IF NOT public.phoenix_profile_has_scoped_permission(
      v_actor,'outlet_stock.recall',v_point.organization_id,NULL,v_point.id) THEN
      RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE='42501';
    END IF;
  END IF;

  IF v_point.status<>'active' THEN
    RAISE EXCEPTION 'distribution_point_inactive' USING ERRCODE='23514';
  END IF;
  IF v_point.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'distribution_point_has_no_return_warehouse' USING ERRCODE='23514';
  END IF;

  v_res := public._phoenix_materialize_outlet_recall_obligation_v1(
    v_move.id,v_number,v_notes,v_actor,v_actor_role,v_point.organization_id);
  RETURN jsonb_build_object('ok',true,'return_number',v_number,
    'obligations_created',COALESCE((v_res->>'created')::integer,0),
    'obligations_reused',COALESCE((v_res->>'reused')::integer,0));
END;
$outlet_recall$;

REVOKE ALL ON FUNCTION public.phoenix_recall_outlet_inbound_movement(uuid,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_recall_outlet_inbound_movement(uuid,text,text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_admin_grant_delegated_scope(uuid,uuid,text,uuid,uuid,boolean)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.phoenix_admin_grant_delegated_network_snapshot(uuid)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.phoenix_admin_revoke_delegated_scope(uuid,uuid,text)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.phoenix_list_delegated_scopes(uuid,boolean)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.phoenix_my_operational_resource_catalog()
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_admin_grant_delegated_scope(uuid,uuid,text,uuid,uuid,boolean)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_admin_grant_delegated_network_snapshot(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_admin_revoke_delegated_scope(uuid,uuid,text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_list_delegated_scopes(uuid,boolean)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_my_operational_resource_catalog()
  TO authenticated;

COMMENT ON TABLE public.profile_delegated_scope_assignments IS
  'M187 cross-institution operational WHERE ledger. Structurally separate from primary profile_scope_assignments; rows grant no permission.';
COMMENT ON TABLE public.delegated_operational_permission_keys IS
  'M187 exact-key cross-institution WHAT firewall. Absence is denial; no prefix or future-key inheritance.';
COMMENT ON FUNCTION public._phoenix_profile_has_delegated_scope_v1(uuid,uuid,uuid,uuid) IS
  'M187 private WHERE-only delegated scope evaluator. It grants no permission and is not executable by API roles.';

DO $verify$
DECLARE
  v_count integer;
  v_def text;
  v_proc regprocedure;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='profile_delegated_scope_assignments'
      AND c.relkind='r' AND c.relrowsecurity) THEN
    RAISE EXCEPTION '187 VERIFY FAILED: delegated table/RLS missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='delegated_operational_permission_keys'
      AND c.relkind='r' AND c.relrowsecurity) THEN
    RAISE EXCEPTION '187 VERIFY FAILED: exact permission firewall/RLS missing';
  END IF;

  SELECT count(*) INTO v_count FROM public.delegated_operational_permission_keys;
  IF v_count <> 34 THEN
    RAISE EXCEPTION '187 VERIFY FAILED: delegated allowlist count %, expected 34',v_count;
  END IF;
  IF EXISTS (SELECT 1 FROM public.delegated_operational_permission_keys
    WHERE permission_key LIKE 'users.%'
       OR permission_key IN ('warehouses.manage','outlets.manage','outlets.assign_officer',
         'replenishment_routes.manage','organization_facilities.manage',
         'warehouse_stock.approve_correction','warehouse_stock.transfer',
         'outlet_stock.approve_correction','warehouse_dispatch.accept',
         'warehouse_dispatch.reject','warehouse_dispatch.audit')) THEN
    RAISE EXCEPTION '187 VERIFY FAILED: administrative/unproven permission crossed firewall';
  END IF;

  SELECT count(*) INTO v_count FROM pg_constraint
  WHERE conrelid='public.profile_delegated_scope_assignments'::regclass
    AND conname IN ('pdsa_warehouse_org_fk','pdsa_point_org_fk',
      'pdsa_scope_type_chk','pdsa_target_matches_scope_chk','pdsa_grant_origin_chk',
      'pdsa_status_chk','pdsa_revoked_after_assigned_chk') AND convalidated;
  IF v_count <> 7 THEN
    RAISE EXCEPTION '187 VERIFY FAILED: delegated constraints incomplete (%)',v_count;
  END IF;
  SELECT count(*) INTO v_count FROM pg_indexes
  WHERE schemaname='public' AND tablename='profile_delegated_scope_assignments'
    AND indexname IN ('pdsa_active_organization_uniq','pdsa_active_warehouse_uniq',
      'pdsa_active_point_uniq');
  IF v_count <> 3 THEN
    RAISE EXCEPTION '187 VERIFY FAILED: active uniqueness indexes incomplete';
  END IF;

  IF to_regprocedure('public._phoenix_delegated_recipient_is_eligible_v1(uuid)') IS NULL
     OR to_regprocedure('public._phoenix_profile_has_delegated_scope_v1(uuid,uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.phoenix_admin_grant_delegated_scope(uuid,uuid,text,uuid,uuid,boolean)') IS NULL
     OR to_regprocedure('public.phoenix_admin_revoke_delegated_scope(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.phoenix_admin_grant_delegated_network_snapshot(uuid)') IS NULL
     OR to_regprocedure('public.phoenix_list_delegated_scopes(uuid,boolean)') IS NULL
     OR to_regprocedure('public.phoenix_my_operational_resource_catalog()') IS NULL THEN
    RAISE EXCEPTION '187 VERIFY FAILED: required function contract missing';
  END IF;
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='phoenix_profile_has_scoped_permission';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '187 VERIFY FAILED: central helper overload count %',v_count;
  END IF;

  FOREACH v_proc IN ARRAY ARRAY[
    'public._phoenix_delegated_recipient_is_eligible_v1(uuid)'::regprocedure,
    'public._phoenix_profile_has_delegated_scope_v1(uuid,uuid,uuid,uuid)'::regprocedure,
    'public.phoenix_admin_grant_delegated_scope(uuid,uuid,text,uuid,uuid,boolean)'::regprocedure,
    'public.phoenix_admin_grant_delegated_network_snapshot(uuid)'::regprocedure,
    'public.phoenix_admin_revoke_delegated_scope(uuid,uuid,text)'::regprocedure,
    'public.phoenix_list_delegated_scopes(uuid,boolean)'::regprocedure,
    'public.phoenix_my_operational_resource_catalog()'::regprocedure,
    'public._phoenix_revoke_delegated_scopes_on_profile_lifecycle_v1()'::regprocedure
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=v_proc AND prosecdef
      AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
      RAISE EXCEPTION '187 VERIFY FAILED: function % lacks definer/search_path hardening',v_proc;
    END IF;
  END LOOP;

  IF has_function_privilege('anon','public.phoenix_admin_grant_delegated_scope(uuid,uuid,text,uuid,uuid,boolean)','EXECUTE')
     OR has_function_privilege('anon','public.phoenix_admin_revoke_delegated_scope(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated','public._phoenix_profile_has_delegated_scope_v1(uuid,uuid,uuid,uuid)','EXECUTE')
     OR has_function_privilege('service_role','public._phoenix_profile_has_delegated_scope_v1(uuid,uuid,uuid,uuid)','EXECUTE')
     OR has_function_privilege('service_role','public._phoenix_revoke_delegated_scopes_on_profile_lifecycle_v1()','EXECUTE')
     OR has_function_privilege('authenticated','public._phoenix_delegated_recipient_is_eligible_v1(uuid)','EXECUTE')
     OR has_function_privilege('service_role','public._phoenix_delegated_recipient_is_eligible_v1(uuid)','EXECUTE')
     OR has_function_privilege('anon','public._phoenix_delegated_recipient_is_eligible_v1(uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.phoenix_admin_grant_delegated_scope(uuid,uuid,text,uuid,uuid,boolean)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.phoenix_admin_revoke_delegated_scope(uuid,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION '187 VERIFY FAILED: RPC/private helper ACL mismatch';
  END IF;
  FOREACH v_proc IN ARRAY ARRAY[
    'public.phoenix_admin_grant_delegated_scope(uuid,uuid,text,uuid,uuid,boolean)'::regprocedure,
    'public.phoenix_admin_grant_delegated_network_snapshot(uuid)'::regprocedure,
    'public.phoenix_admin_revoke_delegated_scope(uuid,uuid,text)'::regprocedure,
    'public.phoenix_list_delegated_scopes(uuid,boolean)'::regprocedure,
    'public.phoenix_my_operational_resource_catalog()'::regprocedure
  ] LOOP
    IF has_function_privilege('anon',v_proc,'EXECUTE')
       OR has_function_privilege('service_role',v_proc,'EXECUTE')
       OR NOT has_function_privilege('authenticated',v_proc,'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
         WHERE p.oid=v_proc AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
       ) THEN
      RAISE EXCEPTION '187 VERIFY FAILED: public RPC % ACL mismatch',v_proc;
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated','public.profile_delegated_scope_assignments','INSERT')
     OR has_table_privilege('authenticated','public.profile_delegated_scope_assignments','UPDATE')
     OR has_table_privilege('authenticated','public.profile_delegated_scope_assignments','DELETE')
     OR has_table_privilege('anon','public.profile_delegated_scope_assignments','SELECT') THEN
    RAISE EXCEPTION '187 VERIFY FAILED: delegated table write/anon privilege present';
  END IF;

  -- Primary/facility scope objects are deliberately untouched.
  SELECT count(*) INTO v_count FROM pg_constraint
  WHERE conrelid='public.profile_scope_assignments'::regclass
    AND conname IN ('psa_warehouse_org_fk','psa_point_org_fk','psa_facility_org_fk',
      'psa_scope_type_chk','psa_target_matches_scope_chk') AND convalidated;
  IF v_count <> 5 OR to_regprocedure('public.phoenix_admin_assign_facility_scopes(uuid,uuid,uuid[])') IS NULL THEN
    RAISE EXCEPTION '187 VERIFY FAILED: primary/facility scope invariant changed';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
  WHERE conrelid='public.profiles'::regclass AND conname='profiles_role_check';
  IF v_def NOT LIKE '%health_center_manager%' THEN
    RAISE EXCEPTION '187 VERIFY FAILED: HCM role/facility invariant missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.profiles'::regclass
      AND tgname='revoke_delegated_scopes_on_profile_lifecycle' AND tgenabled<>'D') THEN
    RAISE EXCEPTION '187 VERIFY FAILED: lifecycle revocation trigger missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='warehouse_stock' AND policyname='warehouse_stock_delegated_select'
      AND qual LIKE '%phoenix_profile_has_scoped_permission%')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='warehouse_stock_movements' AND policyname='warehouse_stock_mov_delegated_select'
       AND qual LIKE '%phoenix_profile_has_scoped_permission%') THEN
    RAISE EXCEPTION '187 VERIFY FAILED: delegated warehouse read bridge missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='warehouse_dispatches' AND policyname='warehouse_dispatches_delegated_select'
      AND qual LIKE '%phoenix_profile_has_scoped_permission%')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='warehouse_dispatch_lines' AND policyname='warehouse_dispatch_lines_delegated_select'
      AND qual LIKE '%phoenix_profile_has_scoped_permission%') THEN
    RAISE EXCEPTION '187 VERIFY FAILED: delegated dispatch read bridge missing';
  END IF;
  RAISE NOTICE 'DELEGATED-OPERATIONAL-ACCESS-187: verified';
END;
$verify$;

COMMIT;
