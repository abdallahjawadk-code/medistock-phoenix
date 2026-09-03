-- ============================================================================
-- MATERIAL-DISPENSING-SUSPENSION-203
--
-- New first-class domain: "Suspended from Dispensing" / موقوف الصرف.
--
-- NOT a synonym for, and never sharing a database state with:
--   * Quarantine (warehouse_quarantine_stock / الحجر الصحي) — physical/quality
--     isolation of a specific batch/lot. Structurally excluded from stock by
--     living in its own table; see 069/099/105/132.
--   * central_items.status IN ('inactive','discontinued') — permanent catalog
--     lifecycle, not a temporary liftable administrative hold.
--   * profiles.status = 'suspended' / organizations suspension / platform
--     broadcast 'inactive' — unrelated entities (user, org, broadcast), not
--     materials. "موقوف" already appears in this codebase for all three; this
--     migration deliberately never reuses that literal string for a material.
--
-- GRANULARITY: keyed on central_item_id (the drug itself), never on
-- material_identity_key (150's batch/presentation-level fingerprint that also
-- folds in concentration/dosage_form/unit snapshots). A regulator suspending
-- "Paracetamol" must block every strength/form/batch tied to that one
-- central_items row — the coarser key is the correct one for this domain.
--
-- SCOPE: organization_id is the required governing scope; distribution_point_id
-- is an optional narrower scope (NULL = organization-wide). Mirrors
-- phoenix_profile_has_scoped_permission's own (organization, warehouse,
-- distribution_point) shape.
--
-- IMMUTABILITY: ordinary app roles can never delete a row (REVOKE, same shape
-- as the quarantine tables) and, once lifted, a row is never touched again.
-- Before lifting, the only legal UPDATE is the lift triple moving from NULL to
-- a complete set, all three at once. The lift/update rule is enforced by
-- trigger, not by convention.
--
-- PRECONDITIONS: 202 applied.
-- ============================================================================

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = '_phoenix_assert_parent_not_archived_v1'
       AND p.pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION '203 PRECONDITION FAILED: 202 missing — apply 202 first';
  END IF;
END;
$precond$;

-- ── 1. Table ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.material_dispensing_suspensions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  central_item_id         uuid NOT NULL REFERENCES public.central_items(id) ON DELETE RESTRICT,
  organization_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  distribution_point_id   uuid REFERENCES public.distribution_points(id) ON DELETE CASCADE,

  reason_code             text NOT NULL CHECK (reason_code IN (
                              'regulatory_hold', 'recall_investigation', 'clinical_safety_concern',
                              'quality_investigation', 'license_or_permit_issue',
                              'supply_integrity_concern', 'other'
                            )),
  reason_detail           text,
  reference_document      text,

  effective_start         timestamptz NOT NULL DEFAULT now(),
  effective_end           timestamptz,

  created_by              uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at              timestamptz NOT NULL DEFAULT now(),

  lifted_by               uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  lifted_at               timestamptz,
  lift_reason             text,

  request_fingerprint     text,

  CONSTRAINT mds_reason_detail_required_for_other CHECK (
    reason_code <> 'other' OR NULLIF(btrim(reason_detail), '') IS NOT NULL
  ),
  CONSTRAINT mds_lift_all_or_nothing CHECK (
    (lifted_at IS NULL AND lifted_by IS NULL AND lift_reason IS NULL)
    OR (lifted_at IS NOT NULL AND lifted_by IS NOT NULL
        AND NULLIF(btrim(lift_reason), '') IS NOT NULL)
  ),
  -- Half-open window: active from effective_start (inclusive) up to but not
  -- including effective_end.
  CONSTRAINT mds_effective_window CHECK (effective_end IS NULL OR effective_end > effective_start)
);

COMMENT ON TABLE public.material_dispensing_suspensions IS
  '203: موقوف الصرف — administrative/regulatory/clinical hold on dispensing a '
  'material (by central_item_id), independent of quarantine. Physical stock is '
  'untouched: this table only gates the dispensing/FEFO/suggestion RPCs.';

CREATE INDEX IF NOT EXISTS mds_active_lookup_idx
  ON public.material_dispensing_suspensions (central_item_id, organization_id)
  WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS mds_org_idx ON public.material_dispensing_suspensions (organization_id);
CREATE INDEX IF NOT EXISTS mds_point_idx
  ON public.material_dispensing_suspensions (distribution_point_id)
  WHERE distribution_point_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mds_request_fingerprint_idx
  ON public.material_dispensing_suspensions (request_fingerprint)
  WHERE request_fingerprint IS NOT NULL;

ALTER TABLE public.material_dispensing_suspensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_dispensing_suspensions FORCE ROW LEVEL SECURITY;

-- No direct client write of any kind — every mutation goes through the
-- SECURITY DEFINER RPCs below (same lockout shape as 069's quarantine tables).
REVOKE INSERT, UPDATE, DELETE ON TABLE public.material_dispensing_suspensions FROM authenticated;
REVOKE ALL ON TABLE public.material_dispensing_suspensions FROM anon;
GRANT SELECT ON TABLE public.material_dispensing_suspensions TO authenticated;

-- ── 2. Immutability trigger ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._phoenix_mds_immutability_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.lifted_at IS NOT NULL THEN
    RAISE EXCEPTION 'suspension_already_lifted_immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW.id                    IS DISTINCT FROM OLD.id
     OR NEW.central_item_id       IS DISTINCT FROM OLD.central_item_id
     OR NEW.organization_id       IS DISTINCT FROM OLD.organization_id
     OR NEW.distribution_point_id IS DISTINCT FROM OLD.distribution_point_id
     OR NEW.reason_code           IS DISTINCT FROM OLD.reason_code
     OR NEW.reason_detail         IS DISTINCT FROM OLD.reason_detail
     OR NEW.reference_document    IS DISTINCT FROM OLD.reference_document
     OR NEW.effective_start       IS DISTINCT FROM OLD.effective_start
     OR NEW.effective_end         IS DISTINCT FROM OLD.effective_end
     OR NEW.created_by            IS DISTINCT FROM OLD.created_by
     OR NEW.created_at            IS DISTINCT FROM OLD.created_at
     OR NEW.request_fingerprint   IS DISTINCT FROM OLD.request_fingerprint
  THEN
    RAISE EXCEPTION 'suspension_core_fields_immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW.lifted_at IS NULL OR NEW.lifted_by IS NULL
     OR NULLIF(btrim(NEW.lift_reason), '') IS NULL THEN
    RAISE EXCEPTION 'suspension_lift_fields_incomplete' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_mds_immutability_v1() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_mds_immutable ON public.material_dispensing_suspensions;
CREATE TRIGGER trg_mds_immutable
BEFORE UPDATE ON public.material_dispensing_suspensions
FOR EACH ROW EXECUTE FUNCTION public._phoenix_mds_immutability_v1();

-- No DELETE for ordinary app roles — enforced by REVOKE in section 1 (the
-- same lockout shape as the quarantine tables use, not a second, stricter
-- mechanism): a trigger that also fired for the table owner would block
-- legitimate superuser-level data-hygiene and rig/test teardown for no
-- additional security benefit over the REVOKE already in place.

-- ── 3. Deterministic active-suspension check (used by RLS and by every ─────
--       enforcement point added in 204+; never duplicated inline elsewhere) ──

CREATE OR REPLACE FUNCTION public._phoenix_is_material_dispensing_suspended_v1(
  p_central_item_id       uuid,
  p_organization_id       uuid,
  p_distribution_point_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.material_dispensing_suspensions s
    WHERE s.central_item_id = p_central_item_id
      AND s.organization_id = p_organization_id
      AND (s.distribution_point_id IS NULL OR s.distribution_point_id = p_distribution_point_id)
      AND s.lifted_at IS NULL
      AND s.effective_start <= now()
      AND (s.effective_end IS NULL OR s.effective_end > now())
  );
$$;

COMMENT ON FUNCTION public._phoenix_is_material_dispensing_suspended_v1(uuid, uuid, uuid) IS
  '203 single source of truth for "is this material actively suspended from '
  'dispensing right now, in this scope". An org-wide row (distribution_point_id '
  'IS NULL) matches every point in the organization; a point-scoped row matches '
  'only that exact point. Every dispensing/FEFO/suggestion enforcement point '
  'must call this — never re-derive the active/lifted/window logic inline.';

REVOKE ALL ON FUNCTION public._phoenix_is_material_dispensing_suspended_v1(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;

-- ── 4. RLS ───────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS mds_select_scoped ON public.material_dispensing_suspensions;
CREATE POLICY mds_select_scoped
  ON public.material_dispensing_suspensions FOR SELECT
  TO authenticated
  USING (
    auth.uid() IS NOT NULL AND (
      public.phoenix_my_role() = 'super_admin'
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'material_dispensing_suspension.view',
           organization_id, NULL, distribution_point_id)
    )
  );

-- ── 5. permission_keys + role defaults ──────────────────────────────────────
--
-- .create / .lift are administrative/regulatory actions: seeded to the
-- administrative roles only, never to front-line outlet/warehouse officers.
-- .view (full row incl. reason_detail/reference_document/lift_reason) follows
-- the same administrative-only shape, so investigative notes never reach a
-- role that cannot also act on them.
-- .view_badge (coded reason only, via the RPC in section 6) is seeded to every
-- role — anyone who might try to dispense or transfer needs to see *that* a
-- material is suspended and its coded reason, just not the free-text notes.

INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES
  ('material_dispensing_suspension.create', 'material_dispensing_suspension', 'create',
   'Suspend a material from dispensing', 'إيقاف مادة عن الصرف', true),
  ('material_dispensing_suspension.lift', 'material_dispensing_suspension', 'lift',
   'Lift a dispensing suspension', 'رفع إيقاف الصرف', true),
  ('material_dispensing_suspension.view', 'material_dispensing_suspension', 'view',
   'View full dispensing-suspension detail', 'عرض تفاصيل إيقاف الصرف الكاملة', false),
  ('material_dispensing_suspension.view_badge', 'material_dispensing_suspension', 'view_badge',
   'See that a material is suspended from dispensing', 'معرفة أن المادة موقوفة عن الصرف', false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('super_admin',               'material_dispensing_suspension.create',    true),
  ('central_warehouse_manager', 'material_dispensing_suspension.create',    true),
  ('institution_admin',         'material_dispensing_suspension.create',    true),
  ('warehouse_officer',         'material_dispensing_suspension.create',    false),
  ('outlet_officer',            'material_dispensing_suspension.create',    false),

  ('super_admin',               'material_dispensing_suspension.lift',      true),
  ('central_warehouse_manager', 'material_dispensing_suspension.lift',      true),
  ('institution_admin',         'material_dispensing_suspension.lift',      true),
  ('warehouse_officer',         'material_dispensing_suspension.lift',      false),
  ('outlet_officer',            'material_dispensing_suspension.lift',      false),

  ('super_admin',               'material_dispensing_suspension.view',      true),
  ('central_warehouse_manager', 'material_dispensing_suspension.view',      true),
  ('institution_admin',         'material_dispensing_suspension.view',      true),
  ('warehouse_officer',         'material_dispensing_suspension.view',      false),
  ('outlet_officer',            'material_dispensing_suspension.view',      false),

  ('super_admin',               'material_dispensing_suspension.view_badge', true),
  ('central_warehouse_manager', 'material_dispensing_suspension.view_badge', true),
  ('institution_admin',         'material_dispensing_suspension.view_badge', true),
  ('warehouse_officer',         'material_dispensing_suspension.view_badge', true),
  ('outlet_officer',            'material_dispensing_suspension.view_badge', true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ── 6. RPCs ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_suspend_material_dispensing(
  p_request_id             uuid,
  p_central_item_id        uuid,
  p_organization_id        uuid,
  p_reason_code            text,
  p_distribution_point_id  uuid DEFAULT NULL,
  p_reason_detail          text DEFAULT NULL,
  p_reference_document     text DEFAULT NULL,
  p_effective_start        timestamptz DEFAULT now(),
  p_effective_end          timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_actor_name  text;
  v_reason_detail text := NULLIF(btrim(p_reason_detail), '');
  v_existing    public.material_dispensing_suspensions%ROWTYPE;
  v_active      public.material_dispensing_suspensions%ROWTYPE;
  v_new         public.material_dispensing_suspensions%ROWTYPE;
  v_fp          text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_central_item_id IS NULL THEN
    RAISE EXCEPTION 'central_item_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_reason_code IS NULL THEN
    RAISE EXCEPTION 'reason_code_required' USING ERRCODE = '23514';
  END IF;
  IF p_reason_code = 'other' AND v_reason_detail IS NULL THEN
    RAISE EXCEPTION 'reason_detail_required_for_other' USING ERRCODE = '23514';
  END IF;
  IF p_effective_end IS NOT NULL AND p_effective_end <= p_effective_start THEN
    RAISE EXCEPTION 'effective_end_must_be_after_start' USING ERRCODE = '23514';
  END IF;

  v_fp := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'suspend_material_dispensing',
    'central_item_id', p_central_item_id,
    'organization_id', p_organization_id,
    'distribution_point_id', p_distribution_point_id,
    'reason_code', p_reason_code,
    'reason_detail', v_reason_detail,
    'reference_document', NULLIF(btrim(p_reference_document), ''),
    'effective_start', p_effective_start,
    'effective_end', p_effective_end
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 203001));

  SELECT * INTO v_existing
  FROM public.material_dispensing_suspensions
  WHERE request_fingerprint = v_fp;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'suspension_id', v_existing.id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.central_items WHERE id = p_central_item_id) THEN
    RAISE EXCEPTION 'central_item_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_organization_id) THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_distribution_point_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.distribution_points
    WHERE id = p_distribution_point_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'distribution_point_not_in_organization' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'material_dispensing_suspension.create', p_organization_id, NULL, p_distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_material_dispensing_suspension_create' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- Same exact scope already active (regardless of request_id) → idempotent
  -- no-op rather than a confusing duplicate row.
  SELECT * INTO v_active
  FROM public.material_dispensing_suspensions s
  WHERE s.central_item_id = p_central_item_id
    AND s.organization_id = p_organization_id
    AND s.distribution_point_id IS NOT DISTINCT FROM p_distribution_point_id
    AND s.lifted_at IS NULL
    AND s.effective_start <= now()
    AND (s.effective_end IS NULL OR s.effective_end > now())
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', false, 'already_active', true,
      'suspension_id', v_active.id
    );
  END IF;

  INSERT INTO public.material_dispensing_suspensions (
    central_item_id, organization_id, distribution_point_id,
    reason_code, reason_detail, reference_document,
    effective_start, effective_end,
    created_by, request_fingerprint
  ) VALUES (
    p_central_item_id, p_organization_id, p_distribution_point_id,
    p_reason_code, v_reason_detail, NULLIF(btrim(p_reference_document), ''),
    p_effective_start, p_effective_end,
    v_actor, v_fp
  )
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    p_organization_id, v_actor, v_actor_role,
    'material_dispensing_suspension.create', 'material_dispensing_suspension', v_new.id,
    (SELECT name FROM public.central_items WHERE id = p_central_item_id),
    jsonb_build_object(
      'distribution_point_id', p_distribution_point_id,
      'reason_code', p_reason_code,
      'reference_document', NULLIF(btrim(p_reference_document), ''),
      'effective_start', p_effective_start,
      'effective_end', p_effective_end
    )
  );

  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'suspension_id', v_new.id);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_suspend_material_dispensing(
  uuid, uuid, uuid, text, uuid, text, text, timestamptz, timestamptz
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_suspend_material_dispensing(
  uuid, uuid, uuid, text, uuid, text, text, timestamptz, timestamptz
) TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_lift_material_dispensing_suspension(
  p_request_id     uuid,
  p_suspension_id  uuid,
  p_lift_reason    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_actor_name  text;
  v_lift_reason text := NULLIF(btrim(p_lift_reason), '');
  v_s           public.material_dispensing_suspensions%ROWTYPE;
  v_existing    public.material_dispensing_suspensions%ROWTYPE;
  v_fp          text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_suspension_id IS NULL THEN
    RAISE EXCEPTION 'suspension_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_lift_reason IS NULL THEN
    RAISE EXCEPTION 'lift_reason_required' USING ERRCODE = '23514';
  END IF;

  v_fp := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'lift_material_dispensing_suspension',
    'suspension_id', p_suspension_id, 'lift_reason', v_lift_reason
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 203002));

  SELECT * INTO v_existing
  FROM public.material_dispensing_suspensions
  WHERE id = p_suspension_id AND lifted_at IS NOT NULL AND request_fingerprint = v_fp;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'suspension_id', v_existing.id);
  END IF;

  SELECT * INTO v_s FROM public.material_dispensing_suspensions WHERE id = p_suspension_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'suspension_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_s.lifted_at IS NOT NULL THEN
    RAISE EXCEPTION 'suspension_already_lifted' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'material_dispensing_suspension.lift',
    v_s.organization_id, NULL, v_s.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_material_dispensing_suspension_lift' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.material_dispensing_suspensions
     SET lifted_by = v_actor, lifted_at = now(), lift_reason = v_lift_reason,
         request_fingerprint = v_fp
   WHERE id = v_s.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_s.organization_id, v_actor, v_actor_role,
    'material_dispensing_suspension.lift', 'material_dispensing_suspension', v_s.id,
    (SELECT name FROM public.central_items WHERE id = v_s.central_item_id),
    jsonb_build_object('lift_reason', v_lift_reason)
  );

  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'suspension_id', v_s.id);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_lift_material_dispensing_suspension(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_lift_material_dispensing_suspension(uuid, uuid, text)
  TO authenticated;

-- Lightweight, broadly-grantable badge status — never returns reason_detail,
-- reference_document, or lift_* fields. Powers the UI badge without exposing
-- administrative notes to roles that hold only .view_badge, not .view.
CREATE OR REPLACE FUNCTION public.phoenix_get_material_dispensing_suspension_status(
  p_central_item_ids       uuid[],
  p_organization_id        uuid,
  p_distribution_point_id  uuid DEFAULT NULL
)
RETURNS TABLE (
  central_item_id  uuid,
  is_suspended     boolean,
  reason_code      text,
  effective_start  timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'material_dispensing_suspension.view_badge',
    p_organization_id, NULL, p_distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_material_dispensing_suspension_view_badge' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    ids.central_item_id,
    public._phoenix_is_material_dispensing_suspended_v1(
      ids.central_item_id, p_organization_id, p_distribution_point_id
    ) AS is_suspended,
    s.reason_code,
    s.effective_start
  FROM unnest(p_central_item_ids) AS ids(central_item_id)
  LEFT JOIN public.material_dispensing_suspensions s
    ON s.central_item_id = ids.central_item_id
   AND s.organization_id = p_organization_id
   AND (s.distribution_point_id IS NULL OR s.distribution_point_id = p_distribution_point_id)
   AND s.lifted_at IS NULL
   AND s.effective_start <= now()
   AND (s.effective_end IS NULL OR s.effective_end > now());
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_get_material_dispensing_suspension_status(uuid[], uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_material_dispensing_suspension_status(uuid[], uuid, uuid)
  TO authenticated;

-- ============================================================================
-- VERIFY
-- ============================================================================

DO $verify$
DECLARE
  v_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'material_dispensing_suspensions'
  ) THEN
    RAISE EXCEPTION '203 VERIFY FAILED: table missing';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.proname IN (
    'phoenix_suspend_material_dispensing',
    'phoenix_lift_material_dispensing_suspension',
    'phoenix_get_material_dispensing_suspension_status',
    '_phoenix_is_material_dispensing_suspended_v1'
  ) AND p.pronamespace = 'public'::regnamespace;
  IF v_count <> 4 THEN
    RAISE EXCEPTION '203 VERIFY FAILED: expected 4 functions, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.permission_keys WHERE module = 'material_dispensing_suspension';
  IF v_count <> 4 THEN
    RAISE EXCEPTION '203 VERIFY FAILED: expected 4 permission_keys rows, found %', v_count;
  END IF;

  RAISE NOTICE 'MATERIAL-DISPENSING-SUSPENSION-203: verified.';
END;
$verify$;
