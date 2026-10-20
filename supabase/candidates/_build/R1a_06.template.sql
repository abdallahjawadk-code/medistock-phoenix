-- ============================================================================
-- R1-a CANDIDATE 06 — governed material registration (R1-A2), shipped INERT.
-- PLACEHOLDER (no migration number; M5: PRE3-C stays unnumbered until D9, no M222 reservation).
-- NOT part of the numbered chain, NOT approved for apply. Requires candidates 01-05.
--
-- Owner-adopted PRE3-C v1.1 manual-source amendments M1-M5:
--  M1 first-class manual provenance ('manual_typed', or 'excel_assist' = identity-only A3 pointer: sheet/row/column/file hash,
--     never a quantity); no fabricated Excel session or source record.
--  M2 a resolved material is linked to a manual DRAFT only through the explicit, separately authorized
--     link_material_request_to_draft; no line of any submitted/approved revision is ever touched.
--  M3 the independent reviewer is an ACTIVE super_admin under the Pharmacy Department home-PDA, holding the explicit
--     reviewer key (placeholder, Q-K), and is never the requester (CHECK + routine). No implicit bypass.
--  M4' every new relation / writer / SECURITY DEFINER routine / policy is in the relation manifest, the ACL manifest and
--     the writer census; the seal gains STRUCTURAL tripwires (not name-based): forced RLS + restrictive policy on every
--     manifest relation, pinned search_path on every manifest SECURITY DEFINER routine, any FK-dependent relation of the
--     plan-revision / request relations absent from the manifest, any routine writing central_items or the request
--     relations absent from the expected list.
--
-- Flow: draft -> submitted -> under_review <-> needs_info -> resolved_existing | approved_new | rejected | cancelled.
-- Writers have EXECUTE for the owner ONLY (never PUBLIC, anon, authenticated, service_role). The grant and the per-organization
-- activation guard are a SEPARATE not-applied candidate (R1b_02). central_items is written by exactly one routine
-- (approve_new_material), never granted to a client.
-- ============================================================================
BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('phoenix_cn_policy.excel_read_restriction_state(uuid)') IS NULL
     OR to_regprocedure('public.phoenix_central_needs_my_capabilities(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'R1a06_precondition_failed: candidates 01-05 must be applied first';
  END IF;
  IF to_regclass('public.central_needs_material_requests') IS NOT NULL THEN
    RAISE EXCEPTION 'R1a06_precondition_failed: already applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'central_items' AND column_name = 'dosage_form') THEN
    RAISE EXCEPTION 'R1a06_precondition_failed: central_items catalog detail columns missing';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Reviewer key (placeholder, Q-K) + predicate allow-list + reviewer predicate (M3)
-- ---------------------------------------------------------------------------
INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous)
VALUES ('central_needs.material_review', 'central_needs', 'material_review',
        'Review material registration requests (placeholder key, Q-K)', 'مراجعة طلبات تسجيل المواد (مفتاح مؤقت، Q-K)', true);

CREATE OR REPLACE FUNCTION phoenix_cn_policy.actor_scope_org(p_key text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
BEGIN
  IF v_actor IS NULL OR p_key IS NULL
     OR p_key NOT IN ('central_needs.view', 'central_needs.import', 'central_needs.edit',
                      'central_needs.approve', 'central_needs.manual_need.set', 'central_needs.material_review') THEN
    RETURN NULL;
  END IF;
  SELECT p.organization_id INTO v_org
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.status = 'active'
     AND p.role IN ('super_admin', 'central_warehouse_manager')
     AND p.organization_id IS NOT NULL;
  IF v_org IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o
                  WHERE o.id = v_org AND o.organization_kind = 'pharmacy_department_authority' AND o.archived_at IS NULL) THEN
    RETURN NULL;
  END IF;
  IF NOT COALESCE(public.phoenix_profile_has_permission(v_actor, p_key), false) THEN RETURN NULL; END IF;
  IF p_key IN ('central_needs.manual_need.set', 'central_needs.material_review')
     AND NOT COALESCE(public.phoenix_profile_has_permission(v_actor, 'central_needs.view'), false) THEN
    RETURN NULL;
  END IF;
  RETURN v_org;
END;
$$;

-- M3: active super_admin + home PDA + explicit key (+ view). Never a bypass: without the explicit key the answer is NULL.
CREATE FUNCTION phoenix_cn_policy.material_reviewer_org()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin' AND p.status = 'active')
              THEN phoenix_cn_policy.actor_scope_org('central_needs.material_review') END
$$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.material_reviewer_org() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.material_reviewer_org() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Normalization, identity key and server-scoped duplicate candidates
-- ---------------------------------------------------------------------------
CREATE FUNCTION phoenix_private.central_material_norm_v1(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT btrim(regexp_replace(lower(translate(
           regexp_replace(COALESCE(p, ''), '[ً-ٰٟـ]', '', 'g'),
           'أإآٱىة', 'اااايه')), '\s+', ' ', 'g'))
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_material_norm_v1(text) FROM PUBLIC, anon, authenticated, service_role;

-- The LOGICAL identity of a material (normalized scientific name + strength + form + unit), independent of any barcode.
CREATE FUNCTION phoenix_private.central_material_name_key_v1(p_scientific text, p_strength text, p_form text, p_unit text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT 'nm:' || phoenix_private.central_material_norm_v1(p_scientific) || '|' || phoenix_private.central_material_norm_v1(p_strength)
         || '|' || phoenix_private.central_material_norm_v1(p_form) || '|' || COALESCE(p_unit, '')
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_material_name_key_v1(text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION phoenix_private.central_material_identity_key_v1(p_scientific text, p_strength text, p_form text, p_unit text, p_barcode text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN NULLIF(btrim(p_barcode), '') IS NOT NULL THEN 'bc:' || btrim(p_barcode)
              ELSE phoenix_private.central_material_name_key_v1(p_scientific, p_strength, p_form, p_unit) END
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_material_identity_key_v1(text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;

-- CATALOG-LEVEL serialization (Director correction). central_items is shared by every organization, and a barcode is only ONE of the
-- two strong identities, so a decision that may create or choose a catalog row serializes on the CATALOG identity - never on the
-- requesting organization or on the request's own identity key. Fixed lock ORDER (logical name first, barcode second) keeps two
-- decisions with crossing identities deadlock-free; the locks are transaction-scoped and every strong/advisory check runs AFTER them.
CREATE FUNCTION phoenix_private.central_material_lock_catalog_v1(p_scientific text, p_strength text, p_form text, p_unit text, p_barcode text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(phoenix_private.central_material_name_key_v1(p_scientific, p_strength, p_form, p_unit), 210004));
  IF NULLIF(btrim(p_barcode), '') IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bc:' || btrim(p_barcode), 210004));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_material_lock_catalog_v1(text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;

-- STRONG = an exact strong identifier (barcode) OR the exact normalized scientific identity (name + strength + form + unit).
-- ADVISORY = trigram similarity (threshold 0.45, unchanged), never decisive, never auto-mapped, NEVER truncated. Read-only; reads central_items only.
CREATE FUNCTION phoenix_private.central_material_candidates_v1(p_scientific text, p_strength text, p_form text, p_unit text, p_barcode text)
RETURNS TABLE (central_item_id uuid, grade text, score real)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH strong AS (
    SELECT ci.id
      FROM public.central_items ci
     WHERE (NULLIF(btrim(p_barcode), '') IS NOT NULL AND ci.barcode = btrim(p_barcode))
        OR (phoenix_private.central_material_norm_v1(ci.name) = phoenix_private.central_material_norm_v1(p_scientific)
            AND phoenix_private.central_material_norm_v1(ci.concentration) = phoenix_private.central_material_norm_v1(p_strength)
            AND phoenix_private.central_material_norm_v1(ci.dosage_form) = phoenix_private.central_material_norm_v1(p_form)
            AND ci.unit = p_unit)
  ), advisory AS (
    SELECT ci.id,
           greatest(public.similarity(phoenix_private.central_material_norm_v1(ci.name), phoenix_private.central_material_norm_v1(p_scientific)),
                    public.similarity(phoenix_private.central_material_norm_v1(ci.name_ar), phoenix_private.central_material_norm_v1(p_scientific))) AS s
      FROM public.central_items ci
     WHERE ci.id NOT IN (SELECT id FROM strong)
  )
  SELECT s.id, 'strong'::text, 1.0::real FROM strong s
  UNION ALL
  -- EVERY advisory candidate at or above the (unchanged) 0.45 threshold is returned: nothing is hidden from the reviewer or from the server check
  (SELECT a.id, 'advisory'::text, a.s FROM advisory a WHERE a.s >= 0.45 ORDER BY a.s DESC, a.id)
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_material_candidates_v1(text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Relations
-- ---------------------------------------------------------------------------
CREATE TABLE public.central_needs_material_requests (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  requester_id      uuid        NOT NULL,
  requester_role    text        NOT NULL,
  status            text        NOT NULL DEFAULT 'draft',
  version           integer     NOT NULL DEFAULT 1,
  scientific_name   text        NOT NULL,
  name_ar           text,
  trade_name        text,
  strength          text,
  dosage_form       text,
  unit              text        NOT NULL,
  barcode           text,
  note              text,
  identity_key      text        NOT NULL,
  provenance_kind   text        NOT NULL,
  provenance        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  plan_revision_id  uuid,
  idempotency_key   text        NOT NULL,
  reviewer_id       uuid,
  review_started_at timestamptz,
  resolved_item_id  uuid        REFERENCES public.central_items(id) ON DELETE RESTRICT,
  decision_reason   text,
  decided_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT central_needs_material_requests_org_key UNIQUE (id, organization_id),
  CONSTRAINT central_needs_material_requests_idem_key UNIQUE (organization_id, requester_id, idempotency_key),
  CONSTRAINT central_needs_material_requests_revision_org_fk FOREIGN KEY (plan_revision_id, organization_id)
    REFERENCES public.central_needs_plan_revisions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT central_needs_material_requests_status_chk CHECK (status IN
    ('draft', 'submitted', 'under_review', 'needs_info', 'resolved_existing', 'approved_new', 'rejected', 'cancelled')),
  CONSTRAINT central_needs_material_requests_unit_chk CHECK (unit IN ('box', 'vial', 'ampoule', 'tablet', 'bottle', 'tube', 'sachet', 'other')),
  CONSTRAINT central_needs_material_requests_text_chk CHECK (
    btrim(scientific_name) <> '' AND char_length(scientific_name) <= 300
    AND (name_ar IS NULL OR (btrim(name_ar) <> '' AND char_length(name_ar) <= 300))
    AND (trade_name IS NULL OR (btrim(trade_name) <> '' AND char_length(trade_name) <= 300))
    AND (strength IS NULL OR (btrim(strength) <> '' AND char_length(strength) <= 200))
    AND (dosage_form IS NULL OR (btrim(dosage_form) <> '' AND char_length(dosage_form) <= 200))
    AND (barcode IS NULL OR (barcode ~ '^[^\s]{1,64}$'))
    AND (note IS NULL OR char_length(note) <= 2000)
    AND (decision_reason IS NULL OR (btrim(decision_reason) <> '' AND char_length(decision_reason) <= 2000))),
  CONSTRAINT central_needs_material_requests_provenance_chk CHECK (
    (provenance_kind = 'manual_typed' AND provenance = '{}'::jsonb)
    OR (provenance_kind = 'excel_assist' AND jsonb_typeof(provenance) = 'object'
        AND (provenance - ARRAY['sheet_index', 'row', 'column', 'file_hash']) = '{}'::jsonb
        AND provenance ? 'file_hash' AND (provenance ->> 'file_hash') ~ '^[0-9a-f]{64}$'
        AND provenance ? 'sheet_index' AND provenance ? 'row')),
  CONSTRAINT central_needs_material_requests_sod_chk CHECK (reviewer_id IS NULL OR reviewer_id <> requester_id),
  CONSTRAINT central_needs_material_requests_shape_chk CHECK (
       (status IN ('draft', 'submitted') AND resolved_item_id IS NULL AND decided_at IS NULL)
    OR (status IN ('under_review', 'needs_info') AND resolved_item_id IS NULL AND reviewer_id IS NOT NULL AND decided_at IS NULL)
    OR (status IN ('resolved_existing', 'approved_new') AND resolved_item_id IS NOT NULL AND reviewer_id IS NOT NULL AND decided_at IS NOT NULL)
    OR (status = 'rejected' AND resolved_item_id IS NULL AND reviewer_id IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
    OR (status = 'cancelled' AND resolved_item_id IS NULL AND decided_at IS NOT NULL))
);
-- one OPEN request per strong identity per organization (duplicate prevention under concurrency)
CREATE UNIQUE INDEX central_needs_material_requests_open_identity_uidx
  ON public.central_needs_material_requests (organization_id, identity_key) WHERE status IN ('submitted', 'under_review', 'needs_info');
-- one request <= one canonical creation, one creation <= one request
CREATE UNIQUE INDEX central_needs_material_requests_created_item_uidx
  ON public.central_needs_material_requests (resolved_item_id) WHERE status = 'approved_new';
CREATE INDEX central_needs_material_requests_org_status_idx ON public.central_needs_material_requests (organization_id, status, created_at DESC);

CREATE TABLE public.central_needs_material_request_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid        NOT NULL,
  organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  seq             integer     NOT NULL,
  event_kind      text        NOT NULL,
  actor_id        uuid        NOT NULL,
  actor_role      text        NOT NULL,
  status_after    text        NOT NULL,
  version_after   integer     NOT NULL,
  note            text,
  detail          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  txid            bigint      NOT NULL DEFAULT pg_catalog.txid_current(),
  CONSTRAINT central_needs_material_request_events_request_fk FOREIGN KEY (request_id, organization_id)
    REFERENCES public.central_needs_material_requests(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT central_needs_material_request_events_seq_key UNIQUE (request_id, seq),
  CONSTRAINT central_needs_material_request_events_kind_chk CHECK (event_kind IN
    ('draft_created', 'edited', 'submitted', 'info_provided', 'review_started', 'info_requested',
     'resolved_existing', 'approved_new', 'rejected', 'cancelled', 'linked')),
  CONSTRAINT central_needs_material_request_events_note_chk CHECK (note IS NULL OR char_length(note) <= 2000)
);

CREATE TABLE public.central_needs_material_request_links (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       uuid        NOT NULL,
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  plan_revision_id uuid        NOT NULL,
  central_item_id  uuid        NOT NULL REFERENCES public.central_items(id) ON DELETE RESTRICT,
  actor_id         uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT central_needs_material_request_links_request_fk FOREIGN KEY (request_id, organization_id)
    REFERENCES public.central_needs_material_requests(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT central_needs_material_request_links_revision_fk FOREIGN KEY (plan_revision_id, organization_id)
    REFERENCES public.central_needs_plan_revisions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT central_needs_material_request_links_key UNIQUE (request_id, plan_revision_id)
);

-- Transition guard on the mutable head ------------------------------------------------------------------------------
CREATE FUNCTION phoenix_private.central_material_transition_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('resolved_existing', 'approved_new', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'material_request_terminal_immutable' USING ERRCODE = '23514', DETAIL = format('request=%s status=%s', OLD.id, OLD.status);
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'material_request_version_must_advance' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.requester_id IS DISTINCT FROM OLD.requester_id
     OR NEW.requester_role IS DISTINCT FROM OLD.requester_role OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.provenance_kind IS DISTINCT FROM OLD.provenance_kind
     OR NEW.provenance IS DISTINCT FROM OLD.provenance OR NEW.plan_revision_id IS DISTINCT FROM OLD.plan_revision_id THEN
    RAISE EXCEPTION 'material_request_identity_immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW.scientific_name, NEW.name_ar, NEW.trade_name, NEW.strength, NEW.dosage_form, NEW.unit, NEW.barcode, NEW.note, NEW.identity_key)
       IS DISTINCT FROM (OLD.scientific_name, OLD.name_ar, OLD.trade_name, OLD.strength, OLD.dosage_form, OLD.unit, OLD.barcode, OLD.note, OLD.identity_key)
     AND OLD.status NOT IN ('draft', 'needs_info') THEN
    RAISE EXCEPTION 'material_request_descriptor_frozen' USING ERRCODE = '23514', DETAIL = format('status=%s', OLD.status);
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft'        AND NEW.status IN ('submitted', 'cancelled'))
    OR (OLD.status = 'submitted'    AND NEW.status IN ('under_review', 'cancelled'))
    OR (OLD.status = 'under_review' AND NEW.status IN ('needs_info', 'resolved_existing', 'approved_new', 'rejected'))
    OR (OLD.status = 'needs_info'   AND NEW.status IN ('under_review', 'cancelled'))) THEN
    RAISE EXCEPTION 'material_request_invalid_transition' USING ERRCODE = '23514', DETAIL = format('%s -> %s', OLD.status, NEW.status);
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_material_transition_guard_v1() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER central_needs_material_requests_r1_10_transition BEFORE UPDATE ON public.central_needs_material_requests
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_material_transition_guard_v1();
CREATE TRIGGER central_needs_material_requests_r1_10_nodelete BEFORE DELETE ON public.central_needs_material_requests
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1();
CREATE TRIGGER central_needs_material_requests_r1_10_truncate BEFORE TRUNCATE ON public.central_needs_material_requests
  FOR EACH STATEMENT EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1();

-- RLS / ACL / append-only ------------------------------------------------------------------------------------------
DO $rel$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['central_needs_material_requests', 'central_needs_material_request_events', 'central_needs_material_request_links'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated, service_role', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.phoenix_status_center_authorized(organization_id, %L))',
                   t || '_select_authorized', t, 'central_needs.view');
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE TO authenticated USING (public._phoenix_central_needs_role_eligible_v1())',
                   t || '_role_eligible_restrictive', t);
    EXECUTE format('CREATE POLICY r1_actor_scope_restrictive ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (organization_id = (SELECT phoenix_cn_policy.actor_scope_org(%L)))',
                   t, 'central_needs.view');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['central_needs_material_request_events', 'central_needs_material_request_links'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1()', t || '_r1_10_immutable', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1()', t || '_r1_10_truncate', t);
  END LOOP;
END
$rel$;

COMMENT ON TABLE public.central_needs_material_requests IS 'R1-A2 (PRE3-C v1.1 + owner M1-M5): governed material registration request. Written only by the SECURITY DEFINER routines; no client DML.';
COMMENT ON TABLE public.central_needs_material_request_events IS 'R1-A2: append-only history of a registration request.';
COMMENT ON TABLE public.central_needs_material_request_links IS 'R1-A2 (M2): append-only explicit link of a resolved material to a manual DRAFT revision. Never touches a need line.';

-- ---------------------------------------------------------------------------
-- 4. Internal helpers (no API access)
-- ---------------------------------------------------------------------------
CREATE FUNCTION phoenix_private.central_material_load_v1(p_request_id uuid, p_expected_version integer)
RETURNS public.central_needs_material_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r public.central_needs_material_requests%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR p_expected_version IS NULL THEN
    RAISE EXCEPTION 'material_request_arguments_required' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO r FROM public.central_needs_material_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'material_request_not_found' USING ERRCODE = 'P0002'; END IF;
  IF r.version <> p_expected_version THEN
    RAISE EXCEPTION 'material_request_stale' USING ERRCODE = '23514', DETAIL = format('expected=%s actual=%s status=%s', p_expected_version, r.version, r.status);
  END IF;
  RETURN r;
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_material_load_v1(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION phoenix_private.central_material_event_v1(p_request_id uuid, p_kind text, p_note text, p_detail jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r public.central_needs_material_requests%ROWTYPE;
  v_role text;
BEGIN
  SELECT * INTO r FROM public.central_needs_material_requests WHERE id = p_request_id;
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = auth.uid();
  INSERT INTO public.central_needs_material_request_events (request_id, organization_id, seq, event_kind, actor_id, actor_role, status_after, version_after, note, detail)
  VALUES (r.id, r.organization_id,
          COALESCE((SELECT max(e.seq) FROM public.central_needs_material_request_events e WHERE e.request_id = r.id), 0) + 1,
          p_kind, auth.uid(), COALESCE(v_role, 'unknown'), r.status, r.version, p_note, COALESCE(p_detail, '{}'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_material_event_v1(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- reviewer prologue: independent (never the requester), explicit reviewer predicate, ASSIGNED reviewer after review start
CREATE FUNCTION phoenix_private.central_material_assert_reviewer_v1(p_org uuid, p_requester uuid, p_assigned uuid, p_require_assigned boolean)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF phoenix_cn_policy.material_reviewer_org() IS DISTINCT FROM p_org THEN
    RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE = '42501', DETAIL = 'permission=central_needs.material_review';
  END IF;
  IF auth.uid() = p_requester THEN
    RAISE EXCEPTION 'central_needs_separation_of_duties_violation' USING ERRCODE = '42501', DETAIL = 'the reviewer is the requester';
  END IF;
  IF p_require_assigned AND p_assigned IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'material_request_not_assigned_reviewer' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_material_assert_reviewer_v1(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;

--@@WRITERS@@

-- ---------------------------------------------------------------------------
-- 6. Readers (granted to authenticated now; they confer nothing beyond RLS / the view scope)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.phoenix_central_needs_list_material_requests(p_organization_id uuid)
RETURNS SETOF public.central_needs_material_requests
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT r.* FROM public.central_needs_material_requests r WHERE r.organization_id = p_organization_id ORDER BY r.created_at DESC, r.id
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_list_material_requests(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_list_material_requests(uuid) TO authenticated;

CREATE FUNCTION public.phoenix_central_needs_list_material_request_events(p_request_id uuid)
RETURNS SETOF public.central_needs_material_request_events
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT e.* FROM public.central_needs_material_request_events e WHERE e.request_id = p_request_id ORDER BY e.seq
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_list_material_request_events(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_list_material_request_events(uuid) TO authenticated;

-- candidates for ONE request: only for a caller with the view scope of the request's organization (empty otherwise: no oracle)
CREATE FUNCTION public.phoenix_central_needs_material_request_candidates(p_request_id uuid)
RETURNS TABLE (central_item_id uuid, grade text, score real, name text, name_ar text, concentration text, dosage_form text, unit text, barcode text, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.central_item_id, c.grade, c.score, ci.name, ci.name_ar, ci.concentration, ci.dosage_form, ci.unit, ci.barcode, ci.status
    FROM public.central_needs_material_requests r
    CROSS JOIN LATERAL phoenix_private.central_material_candidates_v1(r.scientific_name, r.strength, r.dosage_form, r.unit, r.barcode) c
    JOIN public.central_items ci ON ci.id = c.central_item_id
   WHERE r.id = p_request_id
     AND phoenix_cn_policy.actor_scope_org('central_needs.view') = r.organization_id
   ORDER BY (c.grade = 'strong') DESC, c.score DESC, c.central_item_id
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_material_request_candidates(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_material_request_candidates(uuid) TO authenticated;

CREATE FUNCTION public.phoenix_central_needs_my_material_capabilities(p_organization_id uuid)
RETURNS TABLE (can_request boolean, can_review boolean, can_link boolean)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(phoenix_cn_policy.actor_scope_org('central_needs.edit') = p_organization_id, false),
         COALESCE(phoenix_cn_policy.material_reviewer_org() = p_organization_id, false),
         COALESCE(phoenix_cn_policy.actor_scope_org('central_needs.manual_need.set') = p_organization_id, false)
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_my_material_capabilities(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_my_material_capabilities(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Seal restated: 20 relations, the grown ACL manifest, and the structural M4' tripwires
-- ---------------------------------------------------------------------------
--@@SEAL@@

--@@VERIFY@@

COMMIT;
