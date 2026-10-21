-- MIGRATION 228 (R1-a 06). D9 CLOSED: numbered from supabase/candidates/R1a_06_material_registration_inert_v2.sql WITHOUT any change to the SQL below.
-- The bytes after this prelude are exactly that candidate (SHA-256 9273381f8150cb4665afedfafa50f7ff961e8c5712104cd06096945f86fc11a6, revision M224-RBAC-ROOT-FIX); Staging carries the earlier R1a_06_material_registration_inert.sql (SHA-256 37ecc50769d00cbf153f828ff094a64088434f08d4e9e042aee404121b4d3fb1) and converges separately;
-- wording below that says "PLACEHOLDER", "NOT part of the numbered chain" or "D9 open" predates this numbering and is superseded by this prelude.
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
--  M3 the independent reviewer is an ACTIVE member of the Pharmacy Department home-PDA (any role: M224-RBAC-ROOT-FIX), holding
--     the explicit reviewer key (placeholder, Q-K) and view, and is never the requester (CHECK + routine). No implicit bypass.
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

-- M3: active member of the home PDA + explicit reviewer key (+ view), no role class. Never a bypass: without the explicit key
-- the answer is NULL; independence from the requester is enforced by the CHECK and every reviewer routine.
CREATE FUNCTION phoenix_cn_policy.material_reviewer_org()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT phoenix_cn_policy.actor_scope_org('central_needs.material_review')
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

-- ---------------------------------------------------------------------------
-- 5. The eleven writers (owner-only EXECUTE). DML on central_needs_material_* / central_items lives IN each of them.
-- ---------------------------------------------------------------------------

-- 5.1 create draft (requester = central_needs.edit, per PRE3-C v1.1 "requester: central_needs.edit")
CREATE FUNCTION public.phoenix_central_needs_create_material_request_draft(
  p_organization_id uuid, p_scientific_name text, p_name_ar text, p_trade_name text, p_strength text, p_dosage_form text,
  p_unit text, p_barcode text, p_note text, p_provenance_kind text, p_provenance jsonb, p_plan_revision_id uuid, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role  text;
  v_sci   text := public._phoenix_central_needs_human_text_v1(p_scientific_name);
  v_ar    text := public._phoenix_central_needs_human_text_v1(p_name_ar);
  v_trade text := public._phoenix_central_needs_human_text_v1(p_trade_name);
  v_str   text := public._phoenix_central_needs_human_text_v1(p_strength);
  v_form  text := public._phoenix_central_needs_human_text_v1(p_dosage_form);
  v_bar   text := NULLIF(btrim(p_barcode), '');
  v_note  text := public._phoenix_central_needs_human_text_v1(p_note);
  v_prov  jsonb := COALESCE(p_provenance, '{}'::jsonb);
  v_prior public.central_needs_material_requests%ROWTYPE;
  v_new   public.central_needs_material_requests%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_role := public._phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.edit');
  IF v_sci IS NULL THEN RAISE EXCEPTION 'material_scientific_name_required' USING ERRCODE = '23514'; END IF;
  IF p_unit IS NULL THEN RAISE EXCEPTION 'material_unit_required' USING ERRCODE = '23514'; END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'material_idempotency_key_invalid' USING ERRCODE = '23514';
  END IF;
  IF p_provenance_kind IS NULL OR p_provenance_kind NOT IN ('manual_typed', 'excel_assist') THEN
    RAISE EXCEPTION 'material_provenance_invalid' USING ERRCODE = '23514';
  END IF;
  IF p_plan_revision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.central_needs_plan_revisions r
        WHERE r.id = p_plan_revision_id AND r.organization_id = p_organization_id AND r.source_mode = 'manual' AND r.status = 'draft') THEN
    RAISE EXCEPTION 'material_context_revision_ineligible' USING ERRCODE = '23514';
  END IF;

  -- Concurrent retries of ONE intent serialize here: the second waits for the first to commit, then finds it (replay) instead of
  -- racing the unique index. A different content under the same key is still refused below.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || v_actor::text || ':' || p_idempotency_key, 210005));
  SELECT * INTO v_prior FROM public.central_needs_material_requests
   WHERE organization_id = p_organization_id AND requester_id = v_actor AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF (v_prior.scientific_name, v_prior.name_ar, v_prior.trade_name, v_prior.strength, v_prior.dosage_form, v_prior.unit, v_prior.barcode, v_prior.note,
        v_prior.provenance_kind, v_prior.provenance, v_prior.plan_revision_id)
       IS NOT DISTINCT FROM (v_sci, v_ar, v_trade, v_str, v_form, p_unit, v_bar, v_note, p_provenance_kind, v_prov, p_plan_revision_id) THEN
      RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'request_id', v_prior.id, 'status', v_prior.status, 'version', v_prior.version);
    END IF;
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505', DETAIL = format('key=%s', p_idempotency_key);
  END IF;

  INSERT INTO public.central_needs_material_requests (organization_id, requester_id, requester_role, scientific_name, name_ar, trade_name, strength,
    dosage_form, unit, barcode, note, identity_key, provenance_kind, provenance, plan_revision_id, idempotency_key)
  VALUES (p_organization_id, v_actor, v_role, v_sci, v_ar, v_trade, v_str, v_form, p_unit, v_bar, v_note,
          phoenix_private.central_material_identity_key_v1(v_sci, v_str, v_form, p_unit, v_bar),
          p_provenance_kind, v_prov, p_plan_revision_id, p_idempotency_key)
  RETURNING * INTO v_new;
  PERFORM phoenix_private.central_material_event_v1(v_new.id, 'draft_created', NULL, jsonb_build_object('provenance_kind', p_provenance_kind));
  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'request_id', v_new.id, 'status', v_new.status, 'version', v_new.version);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_create_material_request_draft(uuid, text, text, text, text, text, text, text, text, text, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- 5.2 edit draft / needs_info (requester only)
CREATE FUNCTION public.phoenix_central_needs_update_material_request_draft(
  p_request_id uuid, p_expected_version integer, p_scientific_name text, p_name_ar text, p_trade_name text, p_strength text,
  p_dosage_form text, p_unit text, p_barcode text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_req   public.central_needs_material_requests%ROWTYPE;
  v_sci   text := public._phoenix_central_needs_human_text_v1(p_scientific_name);
  v_ar    text := public._phoenix_central_needs_human_text_v1(p_name_ar);
  v_trade text := public._phoenix_central_needs_human_text_v1(p_trade_name);
  v_str   text := public._phoenix_central_needs_human_text_v1(p_strength);
  v_form  text := public._phoenix_central_needs_human_text_v1(p_dosage_form);
  v_bar   text := NULLIF(btrim(p_barcode), '');
  v_note  text := public._phoenix_central_needs_human_text_v1(p_note);
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.edit');
  IF v_req.requester_id <> v_actor THEN RAISE EXCEPTION 'material_request_requester_only' USING ERRCODE = '42501'; END IF;
  IF v_req.status NOT IN ('draft', 'needs_info') THEN
    RAISE EXCEPTION 'material_request_not_editable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  IF v_sci IS NULL OR p_unit IS NULL THEN RAISE EXCEPTION 'material_scientific_name_required' USING ERRCODE = '23514'; END IF;
  UPDATE public.central_needs_material_requests
     SET scientific_name = v_sci, name_ar = v_ar, trade_name = v_trade, strength = v_str, dosage_form = v_form, unit = p_unit,
         barcode = v_bar, note = v_note, identity_key = phoenix_private.central_material_identity_key_v1(v_sci, v_str, v_form, p_unit, v_bar),
         version = v_req.version + 1
   WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'edited', NULL, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_update_material_request_draft(uuid, integer, text, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;

-- 5.3 submit (draft -> submitted) / answer more-info (needs_info -> under_review). Server-scoped duplicate review is recorded.
CREATE FUNCTION public.phoenix_central_needs_submit_material_request(p_request_id uuid, p_expected_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_req   public.central_needs_material_requests%ROWTYPE;
  v_strong integer;
  v_adv    integer;
  v_target text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.edit');
  IF v_req.requester_id <> v_actor THEN RAISE EXCEPTION 'material_request_requester_only' USING ERRCODE = '42501'; END IF;
  IF v_req.status NOT IN ('draft', 'needs_info') THEN
    RAISE EXCEPTION 'material_request_not_submittable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_req.organization_id::text || ':' || v_req.identity_key, 210003));
  SELECT count(*) FILTER (WHERE c.grade = 'strong'), count(*) FILTER (WHERE c.grade = 'advisory') INTO v_strong, v_adv
    FROM phoenix_private.central_material_candidates_v1(v_req.scientific_name, v_req.strength, v_req.dosage_form, v_req.unit, v_req.barcode) c;
  v_target := CASE WHEN v_req.status = 'draft' THEN 'submitted' ELSE 'under_review' END;
  BEGIN
    UPDATE public.central_needs_material_requests SET status = v_target, version = v_req.version + 1 WHERE id = v_req.id RETURNING * INTO v_req;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'material_request_duplicate_open' USING ERRCODE = '23505',
      DETAIL = format('another open request exists for identity %s', v_req.identity_key);
  END;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, CASE WHEN v_target = 'submitted' THEN 'submitted' ELSE 'info_provided' END, NULL,
    jsonb_build_object('strong_matches', v_strong, 'advisory_matches', v_adv));
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version,
                            'strong_matches', v_strong, 'advisory_matches', v_adv);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_submit_material_request(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;

-- 5.4 start review (submitted -> under_review): assigns the independent reviewer
CREATE FUNCTION public.phoenix_central_needs_start_material_review(p_request_id uuid, p_expected_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req public.central_needs_material_requests%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.view');
  PERFORM phoenix_private.central_material_assert_reviewer_v1(v_req.organization_id, v_req.requester_id, NULL, false);
  IF v_req.status <> 'submitted' THEN
    RAISE EXCEPTION 'material_request_not_reviewable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  UPDATE public.central_needs_material_requests
     SET status = 'under_review', reviewer_id = auth.uid(), review_started_at = clock_timestamp(), version = v_req.version + 1
   WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'review_started', NULL, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_start_material_review(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;

-- 5.5 ask for more information (under_review -> needs_info)
CREATE FUNCTION public.phoenix_central_needs_request_material_info(p_request_id uuid, p_expected_version integer, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req  public.central_needs_material_requests%ROWTYPE;
  v_note text := public._phoenix_central_needs_human_text_v1(p_note);
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.view');
  PERFORM phoenix_private.central_material_assert_reviewer_v1(v_req.organization_id, v_req.requester_id, v_req.reviewer_id, true);
  IF v_req.status <> 'under_review' THEN
    RAISE EXCEPTION 'material_request_not_reviewable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  IF v_note IS NULL OR char_length(v_note) > 2000 THEN RAISE EXCEPTION 'material_note_required' USING ERRCODE = '23514'; END IF;
  UPDATE public.central_needs_material_requests SET status = 'needs_info', version = v_req.version + 1 WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'info_requested', v_note, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_request_material_info(uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role;

-- 5.6 resolve to an EXISTING item (terminal)
CREATE FUNCTION public.phoenix_central_needs_resolve_material_existing(p_request_id uuid, p_expected_version integer, p_item_id uuid, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req    public.central_needs_material_requests%ROWTYPE;
  v_note   text := public._phoenix_central_needs_human_text_v1(p_note);
  v_strong uuid[];
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.view');
  PERFORM phoenix_private.central_material_assert_reviewer_v1(v_req.organization_id, v_req.requester_id, v_req.reviewer_id, true);
  IF v_req.status <> 'under_review' THEN
    RAISE EXCEPTION 'material_request_not_reviewable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  IF p_item_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.central_items i WHERE i.id = p_item_id AND i.status = 'active') THEN
    RAISE EXCEPTION 'material_resolution_item_not_active' USING ERRCODE = '23514';
  END IF;
  PERFORM phoenix_private.central_material_lock_catalog_v1(v_req.scientific_name, v_req.strength, v_req.dosage_form, v_req.unit, v_req.barcode);
  SELECT array_agg(c.central_item_id) INTO v_strong
    FROM phoenix_private.central_material_candidates_v1(v_req.scientific_name, v_req.strength, v_req.dosage_form, v_req.unit, v_req.barcode) c
   WHERE c.grade = 'strong';
  IF v_strong IS NOT NULL AND NOT (p_item_id = ANY (v_strong)) THEN
    RAISE EXCEPTION 'material_resolution_must_match_strong' USING ERRCODE = '23514', DETAIL = format('strong_matches=%s', cardinality(v_strong));
  END IF;
  UPDATE public.central_needs_material_requests
     SET status = 'resolved_existing', resolved_item_id = p_item_id, decision_reason = v_note, decided_at = clock_timestamp(), version = v_req.version + 1
   WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'resolved_existing', v_note, jsonb_build_object('central_item_id', p_item_id));
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version, 'central_item_id', p_item_id);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_resolve_material_existing(uuid, integer, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- 5.7 approve a NEW canonical item (terminal). THE ONLY routine that writes central_items.
CREATE FUNCTION public.phoenix_central_needs_approve_new_material(p_request_id uuid, p_expected_version integer, p_acknowledged_candidates uuid[], p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req   public.central_needs_material_requests%ROWTYPE;
  v_note  text := public._phoenix_central_needs_human_text_v1(p_note);
  v_ack   uuid[] := COALESCE(p_acknowledged_candidates, ARRAY[]::uuid[]);
  v_strong integer;
  v_advisory integer;
  v_missing integer;
  v_review_cap constant integer := 50;
  v_item  uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.view');
  PERFORM phoenix_private.central_material_assert_reviewer_v1(v_req.organization_id, v_req.requester_id, v_req.reviewer_id, true);
  IF v_req.status <> 'under_review' THEN
    RAISE EXCEPTION 'material_request_not_reviewable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  -- serialize every decision on the same CATALOG identity (not on the organization), then RE-CHECK the catalog under the locks
  -- (server-side, never client-trusted)
  PERFORM phoenix_private.central_material_lock_catalog_v1(v_req.scientific_name, v_req.strength, v_req.dosage_form, v_req.unit, v_req.barcode);
  SELECT count(*) FILTER (WHERE c.grade = 'strong'),
         count(*) FILTER (WHERE c.grade = 'advisory'),
         count(*) FILTER (WHERE c.grade = 'advisory' AND NOT (c.central_item_id = ANY (v_ack)))
    INTO v_strong, v_advisory, v_missing
    FROM phoenix_private.central_material_candidates_v1(v_req.scientific_name, v_req.strength, v_req.dosage_form, v_req.unit, v_req.barcode) c;
  IF v_strong > 0 THEN
    RAISE EXCEPTION 'material_duplicate_strong_match' USING ERRCODE = '23505', DETAIL = format('strong_matches=%s', v_strong),
      HINT = 'Resolve the request to the existing item instead.';
  END IF;
  -- A human cannot responsibly confirm an unbounded list: above the cap the approval is REFUSED (safe) until the request is narrowed
  -- (resolve to an existing item, ask for more information, or reject). The similarity threshold is not touched.
  IF v_advisory > v_review_cap THEN
    RAISE EXCEPTION 'material_duplicate_review_too_large' USING ERRCODE = '23514', DETAIL = format('advisory_candidates=%s cap=%s', v_advisory, v_review_cap),
      HINT = 'Too many similar catalog items to confirm safely; narrow the request or resolve it to an existing item.';
  END IF;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'material_duplicate_review_required' USING ERRCODE = '23514', DETAIL = format('unacknowledged_advisory_candidates=%s', v_missing),
      HINT = 'A human must confirm that each similar catalog item is not the same material.';
  END IF;
  BEGIN
    INSERT INTO public.central_items (name, name_ar, trade_name, concentration, dosage_form, unit, barcode, status, created_by)
    VALUES (v_req.scientific_name, COALESCE(v_req.name_ar, v_req.scientific_name), v_req.trade_name, v_req.strength, v_req.dosage_form,
            v_req.unit, v_req.barcode, 'active', auth.uid())
    RETURNING id INTO v_item;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'material_duplicate_strong_match' USING ERRCODE = '23505', DETAIL = 'barcode already registered';
  END;
  UPDATE public.central_needs_material_requests
     SET status = 'approved_new', resolved_item_id = v_item, decision_reason = v_note, decided_at = clock_timestamp(), version = v_req.version + 1
   WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'approved_new', v_note,
    jsonb_build_object('central_item_id', v_item, 'acknowledged_candidates', to_jsonb(v_ack)));
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version, 'central_item_id', v_item);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_approve_new_material(uuid, integer, uuid[], text) FROM PUBLIC, anon, authenticated, service_role;

-- 5.8 reject (terminal)
CREATE FUNCTION public.phoenix_central_needs_reject_material_request(p_request_id uuid, p_expected_version integer, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req    public.central_needs_material_requests%ROWTYPE;
  v_reason text := public._phoenix_central_needs_human_text_v1(p_reason);
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.view');
  PERFORM phoenix_private.central_material_assert_reviewer_v1(v_req.organization_id, v_req.requester_id, v_req.reviewer_id, true);
  IF v_req.status <> 'under_review' THEN
    RAISE EXCEPTION 'material_request_not_reviewable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 2000 THEN RAISE EXCEPTION 'material_reason_required' USING ERRCODE = '23514'; END IF;
  UPDATE public.central_needs_material_requests
     SET status = 'rejected', decision_reason = v_reason, decided_at = clock_timestamp(), version = v_req.version + 1
   WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'rejected', v_reason, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_reject_material_request(uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role;

-- 5.9 cancel (requester; draft / submitted / needs_info -> cancelled)
CREATE FUNCTION public.phoenix_central_needs_cancel_material_request(p_request_id uuid, p_expected_version integer, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_req    public.central_needs_material_requests%ROWTYPE;
  v_reason text := public._phoenix_central_needs_human_text_v1(p_reason);
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.edit');
  IF v_req.requester_id <> v_actor THEN RAISE EXCEPTION 'material_request_requester_only' USING ERRCODE = '42501'; END IF;
  IF v_req.status NOT IN ('draft', 'submitted', 'needs_info') THEN
    RAISE EXCEPTION 'material_request_not_cancellable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 2000 THEN RAISE EXCEPTION 'material_reason_required' USING ERRCODE = '23514'; END IF;
  UPDATE public.central_needs_material_requests
     SET status = 'cancelled', decision_reason = v_reason, decided_at = clock_timestamp(), version = v_req.version + 1
   WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'cancelled', v_reason, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_cancel_material_request(uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role;

-- 5.10 explicit linkage of a RESOLVED material to a manual DRAFT revision (M2). Writes the link only - never a need line.
CREATE FUNCTION public.phoenix_central_needs_link_material_request_to_draft(p_request_id uuid, p_plan_revision_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req  public.central_needs_material_requests%ROWTYPE;
  v_link uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  IF p_request_id IS NULL OR p_plan_revision_id IS NULL THEN RAISE EXCEPTION 'material_request_arguments_required' USING ERRCODE = '23514'; END IF;
  SELECT * INTO v_req FROM public.central_needs_material_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'material_request_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.manual_need.set');
  IF v_req.status NOT IN ('resolved_existing', 'approved_new') OR v_req.resolved_item_id IS NULL THEN
    RAISE EXCEPTION 'material_request_not_resolved' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.central_items i WHERE i.id = v_req.resolved_item_id AND i.status = 'active') THEN
    RAISE EXCEPTION 'material_resolution_item_not_active' USING ERRCODE = '23514';
  END IF;
  -- only a manual DRAFT of the SAME organization: a submitted / approved revision is never touched or linked into
  PERFORM 1 FROM public.central_needs_plan_revisions r
   WHERE r.id = p_plan_revision_id AND r.organization_id = v_req.organization_id AND r.source_mode = 'manual' AND r.status = 'draft' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'material_link_revision_ineligible' USING ERRCODE = '23514'; END IF;
  SELECT id INTO v_link FROM public.central_needs_material_request_links WHERE request_id = p_request_id AND plan_revision_id = p_plan_revision_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'link_id', v_link, 'central_item_id', v_req.resolved_item_id);
  END IF;
  INSERT INTO public.central_needs_material_request_links (request_id, organization_id, plan_revision_id, central_item_id, actor_id)
  VALUES (v_req.id, v_req.organization_id, p_plan_revision_id, v_req.resolved_item_id, auth.uid()) RETURNING id INTO v_link;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'linked', NULL, jsonb_build_object('plan_revision_id', p_plan_revision_id));
  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'link_id', v_link, 'central_item_id', v_req.resolved_item_id);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_link_material_request_to_draft(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

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
CREATE OR REPLACE FUNCTION phoenix_private.central_needs_capability_breaches_v1()
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH
  nonroot AS (
    SELECT r.oid, r.rolname
      FROM pg_catalog.pg_roles r
     WHERE NOT r.rolsuper
       AND r.rolname !~ '^pg_'
       AND r.oid <> (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
  ),
  guarded_schema AS (
    SELECT n.oid, n.nspname, n.nspowner
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname IN ('public', 'phoenix_private', 'phoenix_cn_policy')
  ),
  manifest(relname) AS (
    VALUES ('central_needs_plans'), ('central_needs_plan_revisions'), ('central_needs_source_files'),
           ('central_needs_import_sessions'), ('central_needs_source_records'), ('central_needs_record_mappings'),
           ('central_needs_field_overrides'), ('central_needs_import_batches'), ('central_needs_import_batch_entries'),
           ('central_needs_beneficiary_column_mappings'), ('central_needs_beneficiary_regions'),
           ('central_needs_need_lines'), ('central_needs_need_line_sources'), ('central_needs_manual_need_events'),
           ('central_needs_revision_withdrawals'), ('central_needs_manual_coverage_acknowledgements'), ('central_needs_cutover_inventory'),
           ('central_needs_material_requests'), ('central_needs_material_request_events'), ('central_needs_material_request_links')
  ),
  cn AS (
    SELECT c.oid, c.relowner, n.nspname, c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE (n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%')
        OR (n.nspname = 'phoenix_private' AND c.relname = 'central_needs_lifecycle_attestations')
  ),
  acl_manifest(sig) AS (
    VALUES ('phoenix_cn_policy.actor_scope_org(text)'),
           ('public.phoenix_central_needs_actor_authorized(uuid,text)'),
           ('phoenix_private.central_needs_source_mode_immutable_v1()'),
           ('phoenix_private.central_needs_lineage_mode_v1()'),
           ('phoenix_private.central_needs_manual_event_guard_v1()'),
           ('phoenix_private.central_needs_manual_projection_guard_v1()'),
           ('phoenix_private.central_needs_revision_authority_gate_v1()'),
           ('public._phoenix_central_needs_assert_manual_projection_v1()'),
           ('phoenix_cn_policy.excel_sod_enabled()'),
           ('phoenix_private.central_needs_append_only_v1()'),
           ('phoenix_private.central_needs_sod_excluded_v1(uuid,uuid)'),
           ('phoenix_private.central_needs_manual_quantity_v1(text)'),
           ('phoenix_private.central_needs_manual_scope_v1(uuid,uuid,uuid)'),
           ('phoenix_private.central_needs_coverage_digest_v1(uuid,uuid)'),
           ('phoenix_private.central_needs_effective_predecessor_v1(uuid)'),
           ('public.phoenix_central_needs_open_manual_plan_revision(uuid,integer)'),
           ('public.phoenix_central_needs_open_manual_correction_revision(uuid,integer,uuid,text)'),
           ('public.phoenix_central_needs_carry_forward_manual_lines(uuid,uuid)'),
           ('public.phoenix_central_needs_add_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)'),
           ('public.phoenix_central_needs_correct_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)'),
           ('public.phoenix_central_needs_void_manual_need_line(uuid,uuid,uuid,uuid,text,text,uuid,text)'),
           ('public.phoenix_central_needs_withdraw_draft_revision(uuid,uuid,text,text)'),
           ('public.phoenix_central_needs_acknowledge_manual_coverage(uuid,text,text)'),
           ('phoenix_private.central_needs_excel_review_blockers_v1(uuid)'),
           ('phoenix_private.central_needs_submission_state_digest_v1(uuid)'),
           ('public._phoenix_central_needs_review_blockers_v1(uuid)'),
           ('phoenix_cn_policy.material_reviewer_org()'),
           ('phoenix_private.central_material_norm_v1(text)'),
           ('phoenix_private.central_material_name_key_v1(text,text,text,text)'),
           ('phoenix_private.central_material_identity_key_v1(text,text,text,text,text)'),
           ('phoenix_private.central_material_lock_catalog_v1(text,text,text,text,text)'),
           ('phoenix_private.central_material_candidates_v1(text,text,text,text,text)'),
           ('phoenix_private.central_material_transition_guard_v1()'),
           ('phoenix_private.central_material_load_v1(uuid,integer)'),
           ('phoenix_private.central_material_event_v1(uuid,text,text,jsonb)'),
           ('phoenix_private.central_material_assert_reviewer_v1(uuid,uuid,uuid,boolean)'),
           ('public.phoenix_central_needs_create_material_request_draft(uuid,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)'),
           ('public.phoenix_central_needs_update_material_request_draft(uuid,integer,text,text,text,text,text,text,text,text)'),
           ('public.phoenix_central_needs_submit_material_request(uuid,integer)'),
           ('public.phoenix_central_needs_start_material_review(uuid,integer)'),
           ('public.phoenix_central_needs_request_material_info(uuid,integer,text)'),
           ('public.phoenix_central_needs_resolve_material_existing(uuid,integer,uuid,text)'),
           ('public.phoenix_central_needs_approve_new_material(uuid,integer,uuid[],text)'),
           ('public.phoenix_central_needs_reject_material_request(uuid,integer,text)'),
           ('public.phoenix_central_needs_cancel_material_request(uuid,integer,text)'),
           ('public.phoenix_central_needs_link_material_request_to_draft(uuid,uuid)'),
           ('public.phoenix_central_needs_list_material_requests(uuid)'),
           ('public.phoenix_central_needs_list_material_request_events(uuid)'),
           ('public.phoenix_central_needs_material_request_candidates(uuid)'),
           ('public.phoenix_central_needs_my_material_capabilities(uuid)')
  ),
  expected_catalog_writers(proname) AS (
    VALUES
      ('phoenix_central_needs_create_material_request_draft'),
           ('phoenix_central_needs_update_material_request_draft'),
           ('phoenix_central_needs_submit_material_request'),
           ('phoenix_central_needs_start_material_review'),
           ('phoenix_central_needs_request_material_info'),
           ('phoenix_central_needs_resolve_material_existing'),
           ('phoenix_central_needs_approve_new_material'),
           ('phoenix_central_needs_reject_material_request'),
           ('phoenix_central_needs_cancel_material_request'),
           ('phoenix_central_needs_link_material_request_to_draft'),
           ('central_material_event_v1')
  )
  -- (a) no non-root write, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any
  --     Central Needs relation or on the private store
  SELECT pg_catalog.format('%s holds %s on %I.%I', u.rolname, p.priv, cn.nspname, cn.relname)
    FROM nonroot u
   CROSS JOIN cn
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) AS p(priv)
   WHERE u.oid <> cn.relowner
     AND pg_catalog.has_table_privilege(u.oid, cn.oid, p.priv)
  UNION ALL
  SELECT pg_catalog.format('%s holds a column-level %s on %I.%I', u.rolname, p.priv, cn.nspname, cn.relname)
    FROM nonroot u
   CROSS JOIN cn
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(priv)
   WHERE u.oid <> cn.relowner
     AND NOT pg_catalog.has_table_privilege(u.oid, cn.oid, p.priv)
     AND pg_catalog.has_any_column_privilege(u.oid, cn.oid, p.priv)
  UNION ALL
  -- (b) no non-root TRIGGER on any relation of the application schema
  SELECT pg_catalog.format('%s holds TRIGGER on public.%I', u.rolname, c.relname)
    FROM nonroot u
   CROSS JOIN pg_catalog.pg_class c
    JOIN guarded_schema s ON s.oid = c.relnamespace AND s.nspname = 'public'
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND u.oid <> c.relowner
     AND pg_catalog.has_table_privilege(u.oid, c.oid, 'TRIGGER')
  UNION ALL
  -- (c) no non-root CREATE on public, the private schema or the policy schema
  SELECT pg_catalog.format('%s holds %s on schema %I', u.rolname, p.priv, s.nspname)
    FROM nonroot u
   CROSS JOIN guarded_schema s
   CROSS JOIN (VALUES ('CREATE')) AS p(priv)
   WHERE u.oid <> s.nspowner
     AND pg_catalog.has_schema_privilege(u.oid, s.oid, p.priv)
  UNION ALL
  -- (d) no object in a guarded schema owned by an API role
  SELECT pg_catalog.format('%s owns %s %I.%I', r.rolname, o.kind, s.nspname, o.name)
    FROM (SELECT c.relowner AS owner, 'relation' AS kind, c.relname::text AS name, c.relnamespace AS ns FROM pg_catalog.pg_class c
          UNION ALL
          SELECT p.proowner, 'routine', p.proname::text, p.pronamespace FROM pg_catalog.pg_proc p
          UNION ALL
          SELECT t.typowner, 'type', t.typname::text, t.typnamespace FROM pg_catalog.pg_type t
          UNION ALL
          SELECT o.oprowner, 'operator', o.oprname::text, o.oprnamespace FROM pg_catalog.pg_operator o) AS o
    JOIN guarded_schema s ON s.oid = o.ns
    JOIN pg_catalog.pg_roles r ON r.oid = o.owner
   WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
  UNION ALL
  -- (e1) the catalog-derived relation set must equal the manifest
  SELECT pg_catalog.format('unlisted_central_needs_relation %I', c.relname)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%'
     AND c.relname NOT IN (SELECT relname FROM manifest)
  UNION ALL
  SELECT pg_catalog.format('missing_central_needs_relation %I', m.relname)
    FROM manifest m
   WHERE pg_catalog.to_regclass(pg_catalog.format('public.%I', m.relname)) IS NULL
  UNION ALL
  -- (e2) the explicit ACL manifest: PUBLIC, anon or service_role must not EXECUTE
  SELECT pg_catalog.format('routine %s is executable by %s', m.sig, w.who)
    FROM acl_manifest m
   CROSS JOIN LATERAL (SELECT pg_catalog.to_regprocedure(m.sig) AS oid) r
   CROSS JOIN (VALUES ('anon'), ('service_role')) AS w(who)
   WHERE r.oid IS NOT NULL AND pg_catalog.has_function_privilege(w.who, r.oid, 'EXECUTE')
  UNION ALL
  SELECT pg_catalog.format('routine %s is executable by PUBLIC', m.sig)
    FROM acl_manifest m
   CROSS JOIN LATERAL (SELECT pg_catalog.to_regprocedure(m.sig) AS oid) r
   JOIN pg_catalog.pg_proc p ON p.oid = r.oid
   WHERE EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a WHERE a.grantee = 0)
  UNION ALL
  SELECT pg_catalog.format('manifest routine %s is missing', m.sig)
    FROM acl_manifest m
   WHERE pg_catalog.to_regprocedure(m.sig) IS NULL
  UNION ALL
  -- (e3) the policy schema: USAGE for authenticated only
  SELECT pg_catalog.format('%s holds USAGE on schema phoenix_cn_policy', w.who)
    FROM (VALUES ('anon'), ('service_role')) AS w(who)
   WHERE pg_catalog.to_regnamespace('phoenix_cn_policy') IS NOT NULL
     AND pg_catalog.has_schema_privilege(w.who, 'phoenix_cn_policy', 'USAGE')
  UNION ALL
  SELECT 'PUBLIC holds a privilege on schema phoenix_cn_policy'
   WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,
                        pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
                  WHERE n.nspname = 'phoenix_cn_policy' AND a.grantee = 0)
  UNION ALL
  -- M4' (t1): every manifest relation has FORCED row level security
  SELECT pg_catalog.format('relation %I lacks forced row level security', m.relname)
    FROM manifest m JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(pg_catalog.format('public.%I', m.relname))
   WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity)
  UNION ALL
  -- M4' (t2): ... and the restrictive actor-scope policy
  SELECT pg_catalog.format('relation %I lacks the restrictive actor-scope policy', m.relname)
    FROM manifest m JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(pg_catalog.format('public.%I', m.relname))
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy po WHERE po.polrelid = c.oid AND po.polname = 'r1_actor_scope_restrictive' AND NOT po.polpermissive)
  UNION ALL
  -- M4' (t3): every SECURITY DEFINER routine of the ACL manifest pins its search_path
  SELECT pg_catalog.format('manifest routine %s has no pinned search_path', m.sig)
    FROM acl_manifest m JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(m.sig)
   WHERE p.prosecdef AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(COALESCE(p.proconfig, ARRAY[]::text[])) cfg WHERE cfg LIKE 'search_path=%')
  UNION ALL
  -- M4' (t4): STRUCTURAL - a relation with a foreign key to the plan revisions or to the request relations must be in the manifest, whatever its name
  SELECT pg_catalog.format('unlisted_fk_dependent_relation %I', t.relname)
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
   WHERE con.contype = 'f' AND n.nspname = 'public'
     AND con.confrelid IN (pg_catalog.to_regclass('public.central_needs_plan_revisions'), pg_catalog.to_regclass('public.central_needs_material_requests'))
     AND t.relname NOT IN (SELECT relname FROM manifest)
  UNION ALL
  -- M4' (t5): STRUCTURAL - a routine that writes central_items or the request relations must be on the expected list, whatever its name
  SELECT pg_catalog.format('unlisted_catalog_writer %s.%s', n.nspname, p.proname)
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND pg_catalog.regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
         ~* '(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+(only\s+)?(table\s+)?("?public"?\.)?"?(central_items|central_needs_material_[a-z_]+)\y'
     AND p.proname NOT IN (SELECT proname FROM expected_catalog_writers)
$$;

DO $verify$
DECLARE
  v_census text[];
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_catalog.pg_policy po JOIN pg_catalog.pg_class c ON c.oid = po.polrelid
   WHERE c.relname LIKE 'central\_needs\_%' AND po.polname = 'r1_actor_scope_restrictive' AND NOT po.polpermissive AND po.polcmd = 'r';
  IF v_n <> 20 THEN RAISE EXCEPTION 'VERIFY FAILED (R1a06): expected 20 restrictive actor-scope policies, found %', v_n; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%') <> 20 THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a06): public relation set must be exactly 20';
  END IF;
  IF EXISTS (SELECT 1 FROM public.central_needs_material_requests) OR EXISTS (SELECT 1 FROM public.central_needs_material_request_events)
     OR EXISTS (SELECT 1 FROM public.central_needs_material_request_links) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a06): the new relations must be empty';
  END IF;
  SELECT array_agg(p.proname::text ORDER BY p.proname::text COLLATE "C") INTO v_census
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
         ~* '(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+(only\s+)?(table\s+)?("?public"?\.|"?phoenix_private"?\.)?"?central_needs_[a-z_]+';
  IF cardinality(v_census) <> 34 THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a06): the writer census must be exactly 34 routines (23 + 10 writers + the event helper), found % : %', cardinality(v_census), v_census;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
              WHERE ns.nspname = 'public' AND p.proname ~ '^phoenix_central_needs_(create_material_request_draft|update_material_request_draft|submit_material_request|start_material_review|request_material_info|resolve_material_existing|approve_new_material|reject_material_request|cancel_material_request|link_material_request_to_draft)$'
                AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                     OR has_function_privilege('service_role', p.oid, 'EXECUTE')
                     OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a WHERE a.grantee = 0))) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a06): a material-registration writer is executable by an API role (owner only in R1-a)';
  END IF;
  -- NOTE (finding, not changed here): central_items keeps its LEGACY grant + dormant super_admin RLS policy (ci_write_superadmin); no code in src/ uses it.
  -- This candidate neither widens nor narrows it; it adds no grant on central_items. anon must still hold nothing.
  IF has_table_privilege('anon', 'public.central_items', 'INSERT') OR has_table_privilege('anon', 'public.central_items', 'UPDATE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a06): anon holds DML on central_items';
  END IF;
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a06): capability seal reports breaches: %',
      (SELECT string_agg(b, '; ') FROM phoenix_private.central_needs_capability_breaches_v1() AS b);
  END IF;
  -- M224-RBAC-ROOT-FIX: the redefined predicate and the reviewer predicate name no role.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.oid IN ('phoenix_cn_policy.actor_scope_org(text)'::regprocedure, 'phoenix_cn_policy.material_reviewer_org()'::regprocedure)
                AND (p.prosrc ~ 'super_admin|central_warehouse_manager|institution_admin|warehouse_officer|outlet_officer|health_center_manager'
                     OR p.prosrc ~* '\.role\M')) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a06): an eligibility predicate still names a role';
  END IF;
END
$verify$;

COMMIT;
