-- MIGRATION 225 (R1-a 03). D9 CLOSED: numbered from supabase/candidates/R1a_03_lifecycle_relations_and_sod.sql WITHOUT any change to the SQL below.
-- The bytes after this prelude are exactly the candidate (SHA-256 2a422c9d7654d37c54bfb14f21082537b202e68f2843c4d38cbeb02de43ef7c7) that Staging already carries in its ledger;
-- wording below that says "PLACEHOLDER", "NOT part of the numbered chain" or "D9 open" predates this numbering and is superseded by this prelude.
-- ============================================================================
-- R1-a CANDIDATE 03 — withdrawn status, the three remaining relations
-- (withdrawals, coverage acknowledgements, cutover inventory / activation
-- marker), separation of duties in the authority gate, carry-integrity in the
-- manual assertion, and the seal restated for the final 17 relations.
-- PLACEHOLDER (no migration number): NOT part of the numbered chain, NOT
-- approved for apply. Requires candidates 01 and 02.
--
-- Contract: R1-0 ADR rev4d §9.3 c, §9.7, §10.1 (XD-1…XD-4), §11 (VC-8), §12, §13.
-- Excel-revision SoD ships DISABLED (SOD-8 / Q-E): excel_sod_enabled() = false;
-- R1-b replaces that one function body.
-- ============================================================================
BEGIN;

DO $pre$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'R1a03_requires_read_committed';
  END IF;
  IF to_regnamespace('phoenix_cn_policy') IS NULL OR to_regclass('public.central_needs_manual_need_events') IS NULL THEN
    RAISE EXCEPTION 'R1a03_precondition_failed: candidates 01 and 02 must be applied first';
  END IF;
  IF to_regclass('public.central_needs_revision_withdrawals') IS NOT NULL
     OR to_regclass('public.central_needs_manual_coverage_acknowledgements') IS NOT NULL
     OR to_regclass('public.central_needs_cutover_inventory') IS NOT NULL THEN
    RAISE EXCEPTION 'R1a03_precondition_failed: R1-a lifecycle relations already present';
  END IF;
  -- status CHECK: exactly one 'c' constraint on plan_revisions mentioning status, with the expected name and list (ADR XD-4)
  IF (SELECT count(*) FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.central_needs_plan_revisions'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE 'CHECK ((status = ANY%') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                     WHERE conrelid = 'public.central_needs_plan_revisions'::regclass AND contype = 'c'
                       AND conname = 'central_needs_plan_revisions_status_check'
                       AND pg_get_constraintdef(oid) =
                           'CHECK ((status = ANY (ARRAY[''draft''::text, ''submitted''::text, ''approved''::text, ''superseded''::text, ''rejected''::text])))') THEN
    RAISE EXCEPTION 'R1a03_precondition_failed: the status CHECK is not the expected 209 definition';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. `withdrawn` status — forward-only amendment (XD-4). approval_pair_chk is untouched.
-- ---------------------------------------------------------------------------
ALTER TABLE public.central_needs_plan_revisions DROP CONSTRAINT central_needs_plan_revisions_status_check;
ALTER TABLE public.central_needs_plan_revisions ADD CONSTRAINT central_needs_plan_revisions_status_check
  CHECK (status = ANY (ARRAY['draft'::text, 'submitted'::text, 'approved'::text, 'superseded'::text, 'rejected'::text, 'withdrawn'::text]));

-- ---------------------------------------------------------------------------
-- 2. Append-only trigger shared by the three new relations
-- ---------------------------------------------------------------------------
CREATE FUNCTION phoenix_private.central_needs_append_only_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'central_needs_append_only_relation' USING ERRCODE = '23514',
    DETAIL = format('%s on %s is not allowed', TG_OP, TG_TABLE_NAME);
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_append_only_v1() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Revision withdrawals (XD-3)
-- ---------------------------------------------------------------------------
CREATE TABLE public.central_needs_revision_withdrawals (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  plan_id          uuid        NOT NULL,
  plan_revision_id uuid        NOT NULL,
  actor_id         uuid        NOT NULL,
  actor_role       text        NOT NULL,
  reason           text        NOT NULL,
  reference        text,
  state_digest     text        NOT NULL,
  session_counts   jsonb       NOT NULL,
  row_counts       jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  txid             bigint      NOT NULL DEFAULT pg_catalog.txid_current(),
  CONSTRAINT central_needs_revision_withdrawals_revision_org_fk
    FOREIGN KEY (plan_revision_id, organization_id)
    REFERENCES public.central_needs_plan_revisions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT central_needs_revision_withdrawals_plan_org_fk
    FOREIGN KEY (plan_id, organization_id)
    REFERENCES public.central_needs_plans(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT central_needs_revision_withdrawals_revision_key UNIQUE (plan_revision_id),
  CONSTRAINT central_needs_revision_withdrawals_reason_chk CHECK (btrim(reason) <> '' AND char_length(reason) <= 2000),
  CONSTRAINT central_needs_revision_withdrawals_reference_chk CHECK (reference IS NULL OR char_length(reference) <= 200),
  CONSTRAINT central_needs_revision_withdrawals_digest_chk CHECK (state_digest ~ '^[0-9a-f]{64}$')
);
CREATE INDEX central_needs_revision_withdrawals_org_idx ON public.central_needs_revision_withdrawals (organization_id);

-- ---------------------------------------------------------------------------
-- 4. Predecessor-coverage acknowledgements (FM-8 / C18)
-- ---------------------------------------------------------------------------
CREATE TABLE public.central_needs_manual_coverage_acknowledgements (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  plan_id                 uuid        NOT NULL,
  plan_revision_id        uuid        NOT NULL,
  predecessor_revision_id uuid        NOT NULL REFERENCES public.central_needs_plan_revisions(id) ON DELETE RESTRICT,
  omitted_scope_digest    text        NOT NULL,
  omitted_scope_count     integer     NOT NULL,
  reason                  text        NOT NULL,
  actor_id                uuid        NOT NULL,
  actor_role              text        NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  txid                    bigint      NOT NULL DEFAULT pg_catalog.txid_current(),
  CONSTRAINT central_needs_manual_coverage_acks_revision_org_fk
    FOREIGN KEY (plan_revision_id, organization_id)
    REFERENCES public.central_needs_plan_revisions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT central_needs_manual_coverage_acks_plan_org_fk
    FOREIGN KEY (plan_id, organization_id)
    REFERENCES public.central_needs_plans(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT central_needs_manual_coverage_acks_digest_chk CHECK (omitted_scope_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT central_needs_manual_coverage_acks_count_chk CHECK (omitted_scope_count > 0),
  CONSTRAINT central_needs_manual_coverage_acks_reason_chk CHECK (btrim(reason) <> '' AND char_length(reason) <= 2000),
  CONSTRAINT central_needs_manual_coverage_acks_key UNIQUE (plan_revision_id, omitted_scope_digest)
);
CREATE INDEX central_needs_manual_coverage_acks_org_idx ON public.central_needs_manual_coverage_acknowledgements (organization_id);

-- ---------------------------------------------------------------------------
-- 5. Cutover inventory (XD-1) — also carries the per-organization activation
--    marker (entry_kind='activation_marker') that turns on the §10.3 read restriction.
--    Created EMPTY in R1-a; rows are written only by the R1-b migration.
-- ---------------------------------------------------------------------------
CREATE TABLE public.central_needs_cutover_inventory (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  entry_kind        text        NOT NULL DEFAULT 'revision',
  plan_id           uuid,
  plan_revision_id  uuid,
  status_at_cutover text,
  state_digest      text,
  counts            jsonb,
  first_blocker     text,
  actor_sets        jsonb,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT central_needs_cutover_inventory_kind_chk CHECK (entry_kind IN ('revision', 'activation_marker')),
  CONSTRAINT central_needs_cutover_inventory_shape_chk CHECK (
    (entry_kind = 'revision' AND plan_id IS NOT NULL AND plan_revision_id IS NOT NULL AND status_at_cutover IS NOT NULL
       AND state_digest ~ '^[0-9a-f]{64}$' AND counts IS NOT NULL AND actor_sets IS NOT NULL)
    OR (entry_kind = 'activation_marker' AND plan_id IS NULL AND plan_revision_id IS NULL)),
  CONSTRAINT central_needs_cutover_inventory_revision_org_fk
    FOREIGN KEY (plan_revision_id, organization_id)
    REFERENCES public.central_needs_plan_revisions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT central_needs_cutover_inventory_revision_key UNIQUE (plan_revision_id)
);
CREATE UNIQUE INDEX central_needs_cutover_inventory_marker_uidx
  ON public.central_needs_cutover_inventory (organization_id) WHERE entry_kind = 'activation_marker';

-- RLS / ACL / append-only for all three ----------------------------------------
DO $rel$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['central_needs_revision_withdrawals', 'central_needs_manual_coverage_acknowledgements', 'central_needs_cutover_inventory'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated, service_role', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.phoenix_status_center_authorized(organization_id, %L))',
                   t || '_select_authorized', t, 'central_needs.view');
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE TO authenticated USING (public._phoenix_central_needs_role_eligible_v1()) WITH CHECK (public._phoenix_central_needs_role_eligible_v1())',
                   t || '_role_eligible_restrictive', t);
    EXECUTE format('CREATE POLICY r1_actor_scope_restrictive ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (organization_id = (SELECT phoenix_cn_policy.actor_scope_org(%L)))',
                   t, 'central_needs.view');
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1()',
                   t || '_r1_10_immutable', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1()',
                   t || '_r1_10_truncate', t);
  END LOOP;
END
$rel$;

COMMENT ON TABLE public.central_needs_revision_withdrawals IS 'R1-a: append-only record of a governed draft withdrawal (XD-3). Nothing the revision holds is deleted.';
COMMENT ON TABLE public.central_needs_manual_coverage_acknowledgements IS 'R1-a: append-only acknowledgement that scopes of the effective predecessor are intentionally omitted (FM-8). Digest = coverage-v1.';
COMMENT ON TABLE public.central_needs_cutover_inventory IS 'R1-a: append-only R1-b cutover inventory of in-flight Excel revisions and the per-organization D27 activation marker. Empty until R1-b.';

-- ---------------------------------------------------------------------------
-- 6. SoD support: Excel SoD stays disabled until R1-b (SOD-8, Q-E)
-- ---------------------------------------------------------------------------
CREATE FUNCTION phoenix_cn_policy.excel_sod_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT false $$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.excel_sod_enabled() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.excel_sod_enabled() TO authenticated;

CREATE FUNCTION phoenix_private.central_needs_sod_excluded_v1(p_plan_revision_id uuid, p_actor uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_actor IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.central_needs_plan_revisions r WHERE r.id = p_plan_revision_id AND r.created_by = p_actor)
    OR EXISTS (SELECT 1 FROM public.central_needs_manual_need_events e WHERE e.plan_revision_id = p_plan_revision_id AND e.actor_id = p_actor)
    OR EXISTS (SELECT 1 FROM phoenix_private.central_needs_lifecycle_attestations a
                WHERE a.plan_revision_id = p_plan_revision_id AND a.phase = 'submit' AND a.actor_id = p_actor)
    OR EXISTS (SELECT 1 FROM public.central_needs_manual_coverage_acknowledgements k
                WHERE k.plan_revision_id = p_plan_revision_id AND k.actor_id = p_actor)
    OR (phoenix_cn_policy.excel_sod_enabled()
        AND (EXISTS (SELECT 1 FROM public.central_needs_need_lines n WHERE n.plan_revision_id = p_plan_revision_id AND n.mapped_by = p_actor)
          OR EXISTS (SELECT 1 FROM public.central_needs_need_line_sources s
                       JOIN public.central_needs_need_lines n ON n.id = s.need_line_id
                      WHERE n.plan_revision_id = p_plan_revision_id AND s.linked_by = p_actor))));
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_sod_excluded_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. The authority gate, replaced (adds withdrawal and SoD)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION phoenix_private.central_needs_revision_authority_gate_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_key   text;
  v_actor uuid := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF phoenix_cn_policy.actor_scope_org('central_needs.edit') IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE = '42501', DETAIL = 'revision insert';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
    v_key := 'central_needs.edit';
  ELSIF OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected') THEN
    v_key := 'central_needs.approve';
  ELSIF OLD.status = 'approved' AND NEW.status = 'superseded' THEN
    v_key := 'central_needs.approve';
  ELSIF OLD.status = 'draft' AND NEW.status = 'withdrawn' THEN
    v_key := 'central_needs.approve';
  ELSE
    RAISE EXCEPTION 'central_needs_status_transition_forbidden' USING ERRCODE = '23514',
      DETAIL = format('%s -> %s revision=%s', OLD.status, NEW.status, OLD.id);
  END IF;

  IF phoenix_cn_policy.actor_scope_org(v_key) IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE = '42501',
      DETAIL = format('%s -> %s requires %s', OLD.status, NEW.status, v_key);
  END IF;

  IF OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected')
     AND (OLD.source_mode = 'manual' OR phoenix_cn_policy.excel_sod_enabled())
     AND phoenix_private.central_needs_sod_excluded_v1(OLD.id, v_actor) THEN
    RAISE EXCEPTION 'central_needs_separation_of_duties_violation' USING ERRCODE = '42501',
      DETAIL = format('revision=%s transition=%s', OLD.id, NEW.status);
  END IF;

  IF OLD.status = 'approved' AND NEW.status = 'superseded' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM phoenix_private.central_needs_lifecycle_attestations a
        JOIN public.central_needs_plan_revisions r2 ON r2.id = a.plan_revision_id
       WHERE a.phase = 'approve' AND a.txid = pg_catalog.txid_current()
         AND r2.plan_id = OLD.plan_id AND r2.id <> OLD.id
         AND r2.status IN ('submitted', 'approved')) THEN
      RAISE EXCEPTION 'central_needs_supersession_without_approval' USING ERRCODE = '23514',
        DETAIL = format('revision=%s', OLD.id);
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'withdrawn' THEN
    IF OLD.created_by IS NOT DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'central_needs_separation_of_duties_violation' USING ERRCODE = '42501',
        DETAIL = format('revision=%s withdrawer is the opener', OLD.id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.central_needs_revision_withdrawals w
                    WHERE w.plan_revision_id = OLD.id AND w.txid = pg_catalog.txid_current() AND w.actor_id = v_actor) THEN
      RAISE EXCEPTION 'central_needs_withdrawal_without_record' USING ERRCODE = '23514',
        DETAIL = format('revision=%s', OLD.id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. The deferred manual assertion, replaced: adds carry integrity (VC-8)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_assert_manual_projection_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rev   uuid;
  v_ben   uuid;
  v_item  uuid;
  v_wh    uuid;
  v_mode  text;
  v_last  public.central_needs_manual_need_events%ROWTYPE;
  v_rows  integer;
  v_line  public.central_needs_need_lines%ROWTYPE;
  v_count integer;
  v_max   integer;
  v_bad   integer;
  v_kind  text;
BEGIN
  IF TG_TABLE_NAME = 'central_needs_need_lines' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.lineage_mode <> 'manual' THEN RETURN NULL; END IF;
      v_rev := OLD.plan_revision_id; v_ben := OLD.beneficiary_organization_id;
      v_item := OLD.central_item_id; v_wh := OLD.target_warehouse_id;
    ELSE
      IF NEW.lineage_mode <> 'manual' THEN RETURN NULL; END IF;
      v_rev := NEW.plan_revision_id; v_ben := NEW.beneficiary_organization_id;
      v_item := NEW.central_item_id; v_wh := NEW.target_warehouse_id;
    END IF;
  ELSE
    v_rev := NEW.plan_revision_id; v_ben := NEW.beneficiary_organization_id;
    v_item := NEW.central_item_id; v_wh := NEW.target_warehouse_id;
  END IF;

  SELECT r.source_mode INTO v_mode FROM public.central_needs_plan_revisions r WHERE r.id = v_rev;

  -- VC-8 (R1-a 03): a carried_forward event must carry the LAST non-void event of the same logical
  -- line of the plan's approved MANUAL revision, byte-identical quantity and unit.
  IF TG_TABLE_NAME = 'central_needs_manual_need_events' THEN
   IF NEW.event_kind = 'carried_forward' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.central_needs_manual_need_events c
        JOIN public.central_needs_plan_revisions er ON er.id = c.plan_revision_id
        JOIN public.central_needs_plan_revisions nr ON nr.id = NEW.plan_revision_id
       WHERE c.id = NEW.carried_from_event_id
         AND er.source_mode = 'manual' AND er.status = 'approved' AND er.plan_id = nr.plan_id
         AND c.beneficiary_organization_id = NEW.beneficiary_organization_id
         AND c.central_item_id = NEW.central_item_id
         AND c.target_warehouse_id IS NOT DISTINCT FROM NEW.target_warehouse_id
         AND c.event_kind <> 'void'
         AND c.quantity_text = NEW.quantity_text
         AND c.approved_unit IS NOT DISTINCT FROM NEW.approved_unit
         AND NOT EXISTS (SELECT 1 FROM public.central_needs_manual_need_events c2
                          WHERE c2.plan_revision_id = c.plan_revision_id
                            AND c2.beneficiary_organization_id = c.beneficiary_organization_id
                            AND c2.central_item_id = c.central_item_id
                            AND c2.target_warehouse_id IS NOT DISTINCT FROM c.target_warehouse_id
                            AND c2.event_seq > c.event_seq)) THEN
      RAISE EXCEPTION 'manual_carry_integrity_violation' USING ERRCODE = '23514',
        DETAIL = format('revision=%s item=%s carried_from=%s', v_rev, v_item, NEW.carried_from_event_id);
    END IF;
   END IF;
  END IF;

  SELECT e.* INTO v_last
    FROM public.central_needs_manual_need_events e
   WHERE e.plan_revision_id = v_rev AND e.beneficiary_organization_id = v_ben
     AND e.central_item_id = v_item AND e.target_warehouse_id IS NOT DISTINCT FROM v_wh
   ORDER BY e.event_seq DESC LIMIT 1;
  IF NOT FOUND THEN
    -- no chain: a manual projection row may not exist at all
    IF EXISTS (SELECT 1 FROM public.central_needs_need_lines l
                WHERE l.plan_revision_id = v_rev AND l.beneficiary_organization_id = v_ben
                  AND l.central_item_id = v_item AND l.target_warehouse_id IS NOT DISTINCT FROM v_wh
                  AND l.lineage_mode = 'manual') THEN
      RAISE EXCEPTION 'manual_projection_without_chain' USING ERRCODE = '23514',
        DETAIL = format('revision=%s item=%s', v_rev, v_item);
    END IF;
    RETURN NULL;
  END IF;

  -- chain integrity: gapless sequence, each event supersedes the previous one
  SELECT count(*), max(event_seq) INTO v_count, v_max
    FROM public.central_needs_manual_need_events e
   WHERE e.plan_revision_id = v_rev AND e.beneficiary_organization_id = v_ben
     AND e.central_item_id = v_item AND e.target_warehouse_id IS NOT DISTINCT FROM v_wh;
  IF v_count <> v_max THEN
    RAISE EXCEPTION 'manual_event_chain_gap' USING ERRCODE = '23514', DETAIL = format('revision=%s item=%s', v_rev, v_item);
  END IF;
  SELECT count(*) INTO v_bad
    FROM public.central_needs_manual_need_events e
    LEFT JOIN public.central_needs_manual_need_events p ON p.id = e.supersedes_event_id
   WHERE e.plan_revision_id = v_rev AND e.beneficiary_organization_id = v_ben
     AND e.central_item_id = v_item AND e.target_warehouse_id IS NOT DISTINCT FROM v_wh
     AND e.event_seq > 1
     AND (p.id IS NULL OR p.event_seq <> e.event_seq - 1
          OR p.plan_revision_id <> e.plan_revision_id OR p.beneficiary_organization_id <> e.beneficiary_organization_id
          OR p.central_item_id <> e.central_item_id OR p.target_warehouse_id IS DISTINCT FROM e.target_warehouse_id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'manual_event_chain_broken' USING ERRCODE = '23514', DETAIL = format('revision=%s item=%s', v_rev, v_item);
  END IF;

  IF v_mode IS DISTINCT FROM 'manual' THEN
    RAISE EXCEPTION 'manual_events_on_non_manual_revision' USING ERRCODE = '23514', DETAIL = format('revision=%s', v_rev);
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.central_needs_need_lines l
   WHERE l.plan_revision_id = v_rev AND l.beneficiary_organization_id = v_ben
     AND l.central_item_id = v_item AND l.target_warehouse_id IS NOT DISTINCT FROM v_wh;

  IF v_last.event_kind = 'void' THEN
    IF v_rows <> 0 THEN
      RAISE EXCEPTION 'manual_projection_present_after_void' USING ERRCODE = '23514', DETAIL = format('revision=%s item=%s', v_rev, v_item);
    END IF;
  ELSE
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'manual_projection_missing_for_live_event' USING ERRCODE = '23514', DETAIL = format('revision=%s item=%s rows=%s', v_rev, v_item, v_rows);
    END IF;
    SELECT * INTO v_line FROM public.central_needs_need_lines l
     WHERE l.plan_revision_id = v_rev AND l.beneficiary_organization_id = v_ben
       AND l.central_item_id = v_item AND l.target_warehouse_id IS NOT DISTINCT FROM v_wh;
    IF v_line.lineage_mode <> 'manual'
       OR v_line.approved_quantity IS DISTINCT FROM v_last.quantity
       OR v_line.approved_unit IS DISTINCT FROM v_last.approved_unit
       OR v_line.mapping_reason IS DISTINCT FROM v_last.reason
       OR v_line.mapped_by IS DISTINCT FROM v_last.actor_id
       OR v_line.unit_conversion_state <> 'canonical' THEN
      RAISE EXCEPTION 'manual_projection_disagrees_with_last_event' USING ERRCODE = '23514',
        DETAIL = format('revision=%s item=%s event=%s', v_rev, v_item, v_last.id);
    END IF;
    IF EXISTS (SELECT 1 FROM public.central_needs_need_line_sources s WHERE s.need_line_id = v_line.id) THEN
      RAISE EXCEPTION 'manual_line_has_source_lineage' USING ERRCODE = '23514', DETAIL = format('need_line=%s', v_line.id);
    END IF;
    -- beneficiary rule (same as the Excel path): a care institution
    IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_ben AND o.organization_kind = 'care_institution') THEN
      RAISE EXCEPTION 'manual_line_beneficiary_not_care_institution' USING ERRCODE = '23514', DETAIL = format('beneficiary=%s', v_ben);
    END IF;
    -- scope exclusivity: institution-level XOR warehouse-split for one (revision, beneficiary, item)
    IF v_wh IS NULL THEN
      IF EXISTS (SELECT 1 FROM public.central_needs_need_lines l
                  WHERE l.plan_revision_id = v_rev AND l.beneficiary_organization_id = v_ben
                    AND l.central_item_id = v_item AND l.target_warehouse_id IS NOT NULL) THEN
        RAISE EXCEPTION 'manual_line_scope_conflict' USING ERRCODE = '23514', DETAIL = format('revision=%s item=%s', v_rev, v_item);
      END IF;
    ELSIF EXISTS (SELECT 1 FROM public.central_needs_need_lines l
                   WHERE l.plan_revision_id = v_rev AND l.beneficiary_organization_id = v_ben
                     AND l.central_item_id = v_item AND l.target_warehouse_id IS NULL) THEN
      RAISE EXCEPTION 'manual_line_scope_conflict' USING ERRCODE = '23514', DETAIL = format('revision=%s item=%s', v_rev, v_item);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_manual_projection_v1() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. The seal restated for the final 17 relations and the grown ACL manifest
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
           ('central_needs_revision_withdrawals'), ('central_needs_manual_coverage_acknowledgements'), ('central_needs_cutover_inventory')
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
           ('phoenix_private.central_needs_sod_excluded_v1(uuid,uuid)')
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
$$;

DO $verify$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_catalog.pg_policy po JOIN pg_catalog.pg_class c ON c.oid = po.polrelid
   WHERE c.relname LIKE 'central\_needs\_%' AND po.polname = 'r1_actor_scope_restrictive' AND NOT po.polpermissive AND po.polcmd = 'r';
  IF v_n <> 17 THEN RAISE EXCEPTION 'VERIFY FAILED (R1a03): expected 17 restrictive policies, found %', v_n; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%') <> 17 THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a03): public relation set must be exactly 17';
  END IF;
  IF EXISTS (SELECT 1 FROM public.central_needs_cutover_inventory) OR EXISTS (SELECT 1 FROM public.central_needs_revision_withdrawals)
     OR EXISTS (SELECT 1 FROM public.central_needs_manual_coverage_acknowledgements) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a03): the new relations must be empty';
  END IF;
  IF phoenix_cn_policy.excel_sod_enabled() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a03): Excel SoD must ship disabled';
  END IF;
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a03): capability seal reports breaches: %',
      (SELECT string_agg(b, '; ') FROM phoenix_private.central_needs_capability_breaches_v1() AS b);
  END IF;
END
$verify$;

COMMIT;
