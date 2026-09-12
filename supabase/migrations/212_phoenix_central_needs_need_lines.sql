-- ===========================================================================
-- CN-2B CONFORMANCE CORRECTION (212) — the operational Annual Needs projection.
--
-- WHY THIS MIGRATION EXISTS
--
-- v7.3 section 8.1 requires that operational identity and constraints be
-- RELATIONAL: "plan_id, revision_id, organization_id, target_warehouse_id,
-- central_item_id, canonical material identity fields, ... approved/final
-- quantities ... These are real columns so Phoenix can enforce FK, UNIQUE,
-- indexes, authorization, idempotency, joins, reporting. Do not hide these in
-- JSONB." Section 20 requires CN-2B to "map institution/material/unit".
--
-- What M209/M210/M211 actually shipped satisfies most of the contract but not
-- all of it. A conformance audit against v7.3 established:
--
--     material mapping            PRESENT  (record_mappings.central_item_id)
--     business-field overrides    PRESENT  (field_overrides, blessed as JSONB
--                                           by v7.3 section 8.4)
--     revision workflow           PRESENT
--     source evidence             PRESENT  (+ immutability trigger)
--     institution mapping         MISSING
--     unit mapping                MISSING
--     approved quantity           MISSING as a relational value
--     beneficiary dimension       MISSING entirely
--
-- The beneficiary gap is the load-bearing one. `central_needs_plans
-- .organization_id` is the OWNING/authorizing central organization — it is what
-- `_phoenix_central_needs_guard_v1` authorizes against and what every RLS
-- policy reads, and `UNIQUE (organization_id, plan_year)` means one plan per
-- owning org per year. It therefore cannot also denote the institution whose
-- requirement a line belongs to: a single archive carries many institutions'
-- requirements. That column is NOT repurposed here.
--
-- So this migration adds the smallest additive relational projection that lets
-- a human's CN-2B mapping be persisted, and nothing else. It is a STAGE 2
-- CONFORMANCE CORRECTION, not Stage 3: it computes no remaining need, touches
-- no stock, creates no lineage to a transfer line, and introduces no
-- allocation. Those remain CN-4A's scope.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * no ALTER of M209/M210/M211 objects other than CREATE OR REPLACE of the
--     internal blockers function, whose five existing branches are reproduced
--     verbatim and only extended;
--   * no column on any stock/movement table, no second stock ledger, no second
--     transfer engine, no second audit framework (v7.3 section 0/2);
--   * no touch of inventory_transfer_suggestions (v7.3 section 3);
--   * NO BACKFILL of any kind. Existing 2026 evidence is untouched; an
--     operational need line exists only where a human created one.
--
-- HISTORICAL APPROVED REVISIONS (v7.3 section 11.2 / owner decision)
--   The new completeness blockers are evaluated only by
--   `_phoenix_central_needs_review_blockers_v1`, which is consulted by
--   `phoenix_central_needs_review_readiness` and by the submit gate — both of
--   which act on a revision that is still being prepared. An already-approved
--   revision is never re-validated, so no historical approval can be
--   retroactively invalidated by this migration. A revision approved before
--   212 simply remains historical evidence with zero need lines; mapping
--   happens in the next revision opened for that plan. This is asserted by the
--   dynamic suite, not merely argued here.
--
-- QUANTITY REPRESENTATION (owner decision 4)
--   `numeric(20,3)`. Exact, never floating point. Phoenix's stock quantities
--   are `integer`, but an integer column would force the parser/import mapping
--   to ROUND a fractional source quantity, which the owner decision forbids.
--   `numeric(20,3)` is not a new convention either: it is the precision this
--   repository already uses for every exact decimal it stores (unit_price in
--   060/061/067/068/069/071 and item_availability.price in 020). Zero is a
--   valid approved quantity; blank is not zero and is simply no row.
--
-- UNIT REPRESENTATION (owner decision 4)
--   There is no unit catalog table in this schema. The canonical controlled
--   vocabulary is `central_items.unit`'s CHECK list, so that exact list is
--   reused and server-validated here rather than inventing a second catalog.
--   When a source quantity cannot yet be expressed in that vocabulary the line
--   records `unit_conversion_state = 'conversion_required'` and carries NO
--   canonical unit — the conversion is never guessed — and such a line blocks
--   approval until a human resolves it.
--
-- SOURCE MULTIPLICITY (owner decision / section 11 of the order)
--   One logical imported row is a `target_entity`; each of its cells is a
--   `central_needs_source_records` row, so evidence is already many-per-row.
--   Several target entities may legitimately describe the same institution +
--   material (duplicate rows within a sheet, the same material across
--   specialty workbooks). Consolidation is a human act and must stay auditable,
--   so it is modelled explicitly:
--
--       N central_needs_need_line_sources  ->  1 central_needs_need_lines
--
--   `UNIQUE (import_session_id, target_entity)` on the link table makes a
--   source row contribute to AT MOST ONE need line — the same "belongs to at
--   most one" discipline v7.3 section 4 requires of allocation lineage. No
--   source record is rewritten, merged or discarded to achieve consolidation.
--
--   The canonical key is `(plan_revision_id, beneficiary_organization_id,
--   central_item_id)`, which is exactly the accounting scope the owner fixed:
--   plan revision + beneficiary organization + canonical material identity.
--   `target_warehouse_id` is deliberately NOT part of that key, so an
--   institution-level annual need can never be silently fragmented into one
--   row per warehouse; it is optional routing context on the single canonical
--   line. A genuinely warehouse-specific conflict therefore surfaces as a
--   refused write a human must resolve, never as two half-counted lines.
-- ===========================================================================

-- ----------------------------------------------------------------------------
-- 0. Preconditions. Fail closed rather than half-apply.
-- ----------------------------------------------------------------------------
DO $precondition$
BEGIN
  IF to_regclass('public.central_needs_plan_revisions') IS NULL
     OR to_regclass('public.central_needs_record_mappings') IS NULL
     OR to_regclass('public.central_needs_import_sessions') IS NULL THEN
    RAISE EXCEPTION '212_precondition_failed: M209/M210/M211 Central Needs surface is absent';
  END IF;

  IF to_regclass('public.central_needs_need_lines') IS NOT NULL THEN
    RAISE EXCEPTION '212_precondition_failed: central_needs_need_lines already exists';
  END IF;

  -- The canonical unit vocabulary this migration mirrors must still be the one
  -- central_items enforces. If that list ever changes, this migration must be
  -- revisited rather than silently diverge into a second vocabulary.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.central_items'::regclass
       AND contype  = 'c'
       AND pg_get_constraintdef(oid) LIKE '%unit%'
       AND pg_get_constraintdef(oid) LIKE '%box%'
       AND pg_get_constraintdef(oid) LIKE '%sachet%'
  ) THEN
    RAISE EXCEPTION '212_precondition_failed: central_items unit vocabulary CHECK not found';
  END IF;
END;
$precondition$;

-- ----------------------------------------------------------------------------
-- 1. The canonical operational need line.
-- ----------------------------------------------------------------------------
CREATE TABLE public.central_needs_need_lines (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_revision_id            uuid NOT NULL,
  -- The OWNING/authorizing central organization. Same meaning as everywhere
  -- else in Central Needs, so RLS and the guard behave identically here.
  organization_id             uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  -- The institution whose annual requirement this line belongs to. A distinct
  -- dimension from organization_id above; never a substitute for it.
  beneficiary_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  -- Optional routing context. NULL means the requirement is institution-level.
  -- Validated against the beneficiary's own warehouses by the write RPC and
  -- re-checked by the review blockers (no composite FK is available because
  -- `warehouses` carries no UNIQUE (id, organization_id), and this migration
  -- does not alter a core operational table to create one).
  target_warehouse_id         uuid REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  central_item_id             uuid NOT NULL REFERENCES public.central_items(id) ON DELETE RESTRICT,
  approved_quantity           numeric(20,3) NOT NULL,
  -- NULL exactly when unit_conversion_state = 'conversion_required'.
  approved_unit               text,
  unit_conversion_state       text NOT NULL DEFAULT 'canonical',
  -- Evidence only — the unit label as the source expressed it. Never authority.
  source_unit_text            text,
  -- v7.3 section 9: every manual change/link requires a reason.
  mapping_reason              text NOT NULL,
  mapped_by                   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  -- The accounting scope the owner fixed. Warehouse is deliberately excluded.
  CONSTRAINT central_needs_need_lines_scope_key
    UNIQUE (plan_revision_id, beneficiary_organization_id, central_item_id),
  -- Exposed so the link table can prove its parent's owning org declaratively,
  -- matching M209's composite-FK pattern.
  CONSTRAINT central_needs_need_lines_id_org_key UNIQUE (id, organization_id),

  CONSTRAINT central_needs_need_lines_quantity_chk
    CHECK (approved_quantity >= 0),
  CONSTRAINT central_needs_need_lines_unit_vocab_chk
    CHECK (approved_unit IS NULL OR approved_unit IN
      ('box', 'vial', 'ampoule', 'tablet', 'bottle', 'tube', 'sachet', 'other')),
  CONSTRAINT central_needs_need_lines_conversion_vocab_chk
    CHECK (unit_conversion_state IN ('canonical', 'conversion_required')),
  -- The two states are mutually exclusive and individually complete, so a NULL
  -- unit can never mean "unknown".
  CONSTRAINT central_needs_need_lines_conversion_pair_chk
    CHECK (
      (unit_conversion_state = 'canonical'            AND approved_unit IS NOT NULL)
      OR
      (unit_conversion_state = 'conversion_required'  AND approved_unit IS NULL)
    ),
  CONSTRAINT central_needs_need_lines_reason_chk
    CHECK (btrim(mapping_reason) <> ''),

  -- organization_id must be the revision's own owning org.
  CONSTRAINT central_needs_need_lines_revision_org_fk
    FOREIGN KEY (plan_revision_id, organization_id)
    REFERENCES public.central_needs_plan_revisions (id, organization_id)
    ON DELETE RESTRICT
);

CREATE INDEX central_needs_need_lines_revision_idx
  ON public.central_needs_need_lines (plan_revision_id);
CREATE INDEX central_needs_need_lines_beneficiary_item_idx
  ON public.central_needs_need_lines (beneficiary_organization_id, central_item_id);
CREATE INDEX central_needs_need_lines_org_idx
  ON public.central_needs_need_lines (organization_id);
CREATE INDEX central_needs_need_lines_warehouse_idx
  ON public.central_needs_need_lines (target_warehouse_id)
  WHERE target_warehouse_id IS NOT NULL;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.central_needs_need_lines
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at();

COMMENT ON TABLE public.central_needs_need_lines IS
  'CN-2B conformance (212): the canonical operational Annual Needs projection — one approved requirement per (plan revision, beneficiary organization, central item). Relational operational authority per v7.3 section 8.1; source evidence stays in central_needs_source_records. Created only by explicit human mapping; never backfilled, never inferred.';
COMMENT ON COLUMN public.central_needs_need_lines.organization_id IS
  'The OWNING/authorizing central organization — the same dimension every other Central Needs table authorizes on. Not the beneficiary.';
COMMENT ON COLUMN public.central_needs_need_lines.beneficiary_organization_id IS
  'The institution whose annual requirement this line belongs to. Human-authoritative: never inferred from workbook family, sheet name, header match, sheet index, filename or row proximity.';
COMMENT ON COLUMN public.central_needs_need_lines.target_warehouse_id IS
  'Optional routing context, valid only when the source is explicitly warehouse-specific. NULL means institution-level. Must belong to the beneficiary organization.';
COMMENT ON COLUMN public.central_needs_need_lines.approved_quantity IS
  'Exact numeric(20,3). Zero is valid; blank is not zero (it is simply no line). Never rounded at import.';
COMMENT ON COLUMN public.central_needs_need_lines.approved_unit IS
  'Canonical unit from central_items'' controlled vocabulary, or NULL when unit_conversion_state = conversion_required. No second unit catalog exists.';
COMMENT ON COLUMN public.central_needs_need_lines.unit_conversion_state IS
  'canonical = the quantity is expressed in the canonical unit. conversion_required = the source unit could not be safely converted; the conversion is NOT guessed and the line blocks approval.';

ALTER TABLE public.central_needs_need_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_need_lines FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_need_lines FROM PUBLIC;
REVOKE ALL ON TABLE public.central_needs_need_lines FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.central_needs_need_lines FROM authenticated;
GRANT SELECT ON TABLE public.central_needs_need_lines TO authenticated;

-- Read is gated on the OWNING organization, exactly as every other Central
-- Needs policy is. A beneficiary institution does NOT gain read access to the
-- central plan through being named here (v7.3 section 1).
CREATE POLICY central_needs_need_lines_select_authorized
  ON public.central_needs_need_lines FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));

-- ----------------------------------------------------------------------------
-- 2. The auditable N source rows -> 1 need line consolidation.
-- ----------------------------------------------------------------------------
CREATE TABLE public.central_needs_need_line_sources (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  need_line_id      uuid NOT NULL,
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  import_session_id uuid NOT NULL,
  target_entity     text NOT NULL,
  linked_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  linked_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT central_needs_need_line_sources_entity_chk
    CHECK (length(target_entity) > 0),
  -- A source row contributes to AT MOST ONE need line — the same discipline
  -- v7.3 section 4 requires of allocation/request-line lineage.
  CONSTRAINT central_needs_need_line_sources_entity_key
    UNIQUE (import_session_id, target_entity),
  CONSTRAINT central_needs_need_line_sources_line_org_fk
    FOREIGN KEY (need_line_id, organization_id)
    REFERENCES public.central_needs_need_lines (id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT central_needs_need_line_sources_session_org_fk
    FOREIGN KEY (import_session_id, organization_id)
    REFERENCES public.central_needs_import_sessions (id, organization_id)
    ON DELETE RESTRICT
);

CREATE INDEX central_needs_need_line_sources_line_idx
  ON public.central_needs_need_line_sources (need_line_id);
CREATE INDEX central_needs_need_line_sources_session_idx
  ON public.central_needs_need_line_sources (import_session_id);

COMMENT ON TABLE public.central_needs_need_line_sources IS
  'CN-2B conformance (212): the auditable consolidation relation — which imported target entities a human folded into one canonical need line. Append/replace only through the write RPC; immutable source evidence is never rewritten to record a consolidation.';

ALTER TABLE public.central_needs_need_line_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_need_line_sources FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_need_line_sources FROM PUBLIC;
REVOKE ALL ON TABLE public.central_needs_need_line_sources FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.central_needs_need_line_sources FROM authenticated;
GRANT SELECT ON TABLE public.central_needs_need_line_sources TO authenticated;

CREATE POLICY central_needs_need_line_sources_select_authorized
  ON public.central_needs_need_line_sources FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));

-- ----------------------------------------------------------------------------
-- 3. Beneficiary eligibility — reuse, do not invent.
--
-- There is no central->institution allow-list relation in this schema; 068's
-- transfer requests validate a destination through warehouse ownership, not a
-- membership table. So eligibility is the narrowest established fact: the
-- beneficiary must be a live care_institution organization. This grants NO
-- cross-org privilege — only the owning org can read its own plan's lines.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_assert_beneficiary_v1(
  p_beneficiary_organization_id uuid,
  p_target_warehouse_id         uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind   text;
  v_status text;
  v_wh_org uuid;
BEGIN
  IF p_beneficiary_organization_id IS NULL THEN
    RAISE EXCEPTION 'beneficiary_organization_required' USING ERRCODE = '23514';
  END IF;

  SELECT organization_kind, status INTO v_kind, v_status
    FROM public.organizations
   WHERE id = p_beneficiary_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'beneficiary_organization_not_found' USING ERRCODE = '23503';
  END IF;

  IF v_kind IS DISTINCT FROM 'care_institution' THEN
    RAISE EXCEPTION 'beneficiary_must_be_care_institution' USING ERRCODE = '23514',
      DETAIL = format('organization_kind=%s', v_kind);
  END IF;

  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'beneficiary_organization_not_active' USING ERRCODE = '23514',
      DETAIL = format('status=%s', v_status);
  END IF;

  IF p_target_warehouse_id IS NOT NULL THEN
    SELECT organization_id INTO v_wh_org
      FROM public.warehouses
     WHERE id = p_target_warehouse_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_warehouse_not_found' USING ERRCODE = '23503';
    END IF;

    IF v_wh_org IS DISTINCT FROM p_beneficiary_organization_id THEN
      RAISE EXCEPTION 'target_warehouse_not_owned_by_beneficiary' USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid) IS
  'CN-2B conformance (212) internal: the single definition of beneficiary eligibility — a live care_institution, plus warehouse ownership when a target warehouse is named. Server-side only; never trusts a UI-validated value.';

-- ----------------------------------------------------------------------------
-- 4. The one narrow canonical write primitive.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_set_need_line(
  p_plan_revision_id            uuid,
  p_beneficiary_organization_id uuid,
  p_central_item_id             uuid,
  p_approved_quantity           numeric,
  p_mapping_reason              text,
  p_approved_unit               text    DEFAULT NULL,
  p_unit_conversion_state       text    DEFAULT 'canonical',
  p_target_warehouse_id         uuid    DEFAULT NULL,
  p_source_unit_text            text    DEFAULT NULL,
  p_source_target_entities      jsonb   DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_revision   public.central_needs_plan_revisions%ROWTYPE;
  v_reason     text := NULLIF(btrim(p_mapping_reason), '');
  v_state      text := NULLIF(btrim(p_unit_conversion_state), '');
  v_unit       text := NULLIF(btrim(p_approved_unit), '');
  v_line_id    uuid;
  v_link_count integer := 0;
  v_entity     text;
  v_session    uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  v_revision := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);

  -- Authorization on the OWNING org, through the canonical helper. Identical to
  -- every other Central Needs write.
  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.edit');
  PERFORM public._phoenix_central_needs_assert_org_live_v1(v_revision.organization_id);

  -- Only a still-editable revision may have its mappings changed. Approved
  -- history is never mutated in place (v7.3 section 11.2).
  PERFORM public._phoenix_central_needs_assert_draft_v1(v_revision.id, v_revision.status);

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'mapping_reason_required' USING ERRCODE = '23514';
  END IF;
  IF p_central_item_id IS NULL THEN
    RAISE EXCEPTION 'central_item_required' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.central_items WHERE id = p_central_item_id) THEN
    RAISE EXCEPTION 'central_item_not_found' USING ERRCODE = '23503';
  END IF;
  IF p_approved_quantity IS NULL THEN
    RAISE EXCEPTION 'approved_quantity_required' USING ERRCODE = '23514';
  END IF;
  IF p_approved_quantity < 0 THEN
    RAISE EXCEPTION 'approved_quantity_must_not_be_negative' USING ERRCODE = '23514';
  END IF;
  IF v_state IS NULL OR v_state NOT IN ('canonical', 'conversion_required') THEN
    RAISE EXCEPTION 'unit_conversion_state_invalid' USING ERRCODE = '23514';
  END IF;
  IF v_state = 'canonical' AND v_unit IS NULL THEN
    RAISE EXCEPTION 'canonical_unit_required' USING ERRCODE = '23514';
  END IF;
  IF v_state = 'conversion_required' AND v_unit IS NOT NULL THEN
    RAISE EXCEPTION 'conversion_required_must_not_carry_unit' USING ERRCODE = '23514';
  END IF;

  PERFORM public._phoenix_central_needs_assert_beneficiary_v1(
    p_beneficiary_organization_id, p_target_warehouse_id);

  INSERT INTO public.central_needs_need_lines (
    plan_revision_id, organization_id, beneficiary_organization_id,
    target_warehouse_id, central_item_id, approved_quantity, approved_unit,
    unit_conversion_state, source_unit_text, mapping_reason, mapped_by
  ) VALUES (
    v_revision.id, v_revision.organization_id, p_beneficiary_organization_id,
    p_target_warehouse_id, p_central_item_id, p_approved_quantity, v_unit,
    v_state, NULLIF(btrim(coalesce(p_source_unit_text, '')), ''), v_reason, v_actor
  )
  ON CONFLICT (plan_revision_id, beneficiary_organization_id, central_item_id)
  DO UPDATE SET
    target_warehouse_id   = EXCLUDED.target_warehouse_id,
    approved_quantity     = EXCLUDED.approved_quantity,
    approved_unit         = EXCLUDED.approved_unit,
    unit_conversion_state = EXCLUDED.unit_conversion_state,
    source_unit_text      = EXCLUDED.source_unit_text,
    mapping_reason        = EXCLUDED.mapping_reason,
    mapped_by             = EXCLUDED.mapped_by
  RETURNING id INTO v_line_id;

  -- Replace this line's declared source links. Evidence itself is untouched.
  DELETE FROM public.central_needs_need_line_sources WHERE need_line_id = v_line_id;

  IF jsonb_typeof(p_source_target_entities) <> 'array' THEN
    RAISE EXCEPTION 'source_target_entities_must_be_array' USING ERRCODE = '23514';
  END IF;

  FOR v_session, v_entity IN
    SELECT (e->>'importSessionId')::uuid, btrim(e->>'targetEntity')
      FROM jsonb_array_elements(p_source_target_entities) AS e
  LOOP
    IF v_session IS NULL OR v_entity IS NULL OR v_entity = '' THEN
      RAISE EXCEPTION 'source_link_requires_session_and_target_entity' USING ERRCODE = '23514';
    END IF;

    -- The session must belong to THIS revision, so a link can never import
    -- evidence from another plan.
    IF NOT EXISTS (
      SELECT 1 FROM public.central_needs_import_sessions
       WHERE id = v_session AND plan_revision_id = v_revision.id
    ) THEN
      RAISE EXCEPTION 'source_link_session_not_in_revision' USING ERRCODE = '23514',
        DETAIL = format('session=%s', v_session);
    END IF;

    -- Only a row a human dispositioned as 'mapped' may feed an operational
    -- line. A 'not_applicable' row is evidence, never a requirement.
    IF NOT EXISTS (
      SELECT 1 FROM public.central_needs_record_mappings
       WHERE import_session_id = v_session
         AND target_entity     = v_entity
         AND decision          = 'mapped'
    ) THEN
      RAISE EXCEPTION 'source_link_requires_mapped_disposition' USING ERRCODE = '23514',
        DETAIL = format('session=%s target_entity=%s', v_session, v_entity);
    END IF;

    INSERT INTO public.central_needs_need_line_sources (
      need_line_id, organization_id, import_session_id, target_entity, linked_by
    ) VALUES (
      v_line_id, v_revision.organization_id, v_session, v_entity, v_actor
    );
    v_link_count := v_link_count + 1;
  END LOOP;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id,
    entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.need_line.set', 'central_needs_need_line', v_line_id,
    NULL,
    jsonb_build_object(
      'plan_revision_id', v_revision.id,
      'beneficiary_organization_id', p_beneficiary_organization_id,
      'central_item_id', p_central_item_id,
      'target_warehouse_id', p_target_warehouse_id,
      'approved_quantity', p_approved_quantity,
      'approved_unit', v_unit,
      'unit_conversion_state', v_state,
      'source_link_count', v_link_count,
      'mapping_reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'need_line_id', v_line_id,
    'source_link_count', v_link_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_set_need_line(
  uuid, uuid, uuid, numeric, text, text, text, uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_set_need_line(
  uuid, uuid, uuid, numeric, text, text, text, uuid, text, jsonb) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_set_need_line(
  uuid, uuid, uuid, numeric, text, text, text, uuid, text, jsonb) IS
  'CN-2B conformance (212): the one canonical write primitive for an operational Annual Needs line. Validates authorization, revision editability, owning org, beneficiary eligibility, warehouse ownership, material, unit vocabulary, conversion state, quantity sign, source lineage and reason server-side, then upserts the canonical line and replaces its declared source links. Draft revisions only. Fully audited. Never trusts a UI-validated value.';

-- ----------------------------------------------------------------------------
-- 5. Review completeness — EXTENDED, never weakened.
--
-- The five branches M211 defined are reproduced verbatim below; four new
-- branches are appended. A revision therefore still cannot be submitted for any
-- reason it could not be submitted for before 212.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_review_blockers_v1(
  p_plan_revision_id uuid
)
RETURNS TABLE (blocker text, detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- 1. Nothing authoritative has landed yet.
  SELECT 'no_finalized_import'::text, NULL::text
   WHERE NOT EXISTS (
     SELECT 1 FROM public.central_needs_import_sessions
      WHERE plan_revision_id = p_plan_revision_id AND status = 'completed'
   )

  UNION ALL
  -- 2. An attempt is still open. 'failed' is terminal history and never blocks.
  SELECT 'import_session_still_open', format('session=%s status=%s', s.id, s.status)
    FROM public.central_needs_import_sessions s
   WHERE s.plan_revision_id = p_plan_revision_id
     AND s.status IN ('pending', 'processing')

  UNION ALL
  -- 3. A completed session that no registered batch claims. This is the
  --    partial-ZIP / crashed-worker case.
  SELECT 'completed_session_not_in_trusted_batch', format('session=%s', s.id)
    FROM public.central_needs_import_sessions s
   WHERE s.plan_revision_id = p_plan_revision_id
     AND s.status = 'completed'
     AND NOT EXISTS (
       SELECT 1 FROM public.central_needs_import_batch_entries e
        WHERE e.import_session_id = s.id
     )

  UNION ALL
  -- 4. A registered batch whose declared accepted-entry count disagrees with
  --    the rows actually present. Registration is atomic, so this should be
  --    unreachable; it is defence in depth against any later writer.
  SELECT 'incomplete_trusted_batch',
         format('batch=%s declared=%s present=%s', b.id, b.accepted_entry_count,
                (SELECT count(*) FROM public.central_needs_import_batch_entries e WHERE e.batch_id = b.id))
    FROM public.central_needs_import_batches b
   WHERE b.plan_revision_id = p_plan_revision_id
     AND b.accepted_entry_count <> (
       SELECT count(*) FROM public.central_needs_import_batch_entries e WHERE e.batch_id = b.id
     )

  UNION ALL
  -- 5. A target entity in authoritative evidence with no explicit human
  --    disposition. The server never guesses which rows "need" mapping; it
  --    requires that a reviewer decided about each one.
  SELECT 'target_entity_without_disposition', format('session=%s target_entity=%s', d.import_session_id, d.target_entity)
    FROM (
      SELECT DISTINCT r.import_session_id, r.target_entity
        FROM public.central_needs_source_records r
        JOIN public.central_needs_import_sessions s ON s.id = r.import_session_id
       WHERE s.plan_revision_id = p_plan_revision_id
         AND s.status = 'completed'
    ) d
   WHERE NOT EXISTS (
     SELECT 1 FROM public.central_needs_record_mappings m
      WHERE m.import_session_id = d.import_session_id
        AND m.target_entity     = d.target_entity
   )

  UNION ALL
  -- 6. (212) A row a human dispositioned as 'mapped' that no operational need
  --    line claims. v7.3 section 8.1 requires the approved requirement to be
  --    relational, so a mapped row with no need line is an incomplete mapping.
  SELECT 'mapped_target_entity_without_need_line',
         format('session=%s target_entity=%s', m.import_session_id, m.target_entity)
    FROM public.central_needs_record_mappings m
    JOIN public.central_needs_import_sessions s ON s.id = m.import_session_id
   WHERE s.plan_revision_id = p_plan_revision_id
     AND s.status   = 'completed'
     AND m.decision = 'mapped'
     AND NOT EXISTS (
       SELECT 1 FROM public.central_needs_need_line_sources ls
        WHERE ls.import_session_id = m.import_session_id
          AND ls.target_entity     = m.target_entity
     )

  UNION ALL
  -- 7. (212) A need line whose source unit could not be converted. The
  --    conversion is never guessed, so approval waits for a human.
  SELECT 'need_line_unit_conversion_required',
         format('need_line=%s item=%s', n.id, n.central_item_id)
    FROM public.central_needs_need_lines n
   WHERE n.plan_revision_id = p_plan_revision_id
     AND n.unit_conversion_state = 'conversion_required'

  UNION ALL
  -- 8. (212) Defence in depth: a target warehouse that is not the
  --    beneficiary's. The write RPC already refuses this.
  SELECT 'need_line_warehouse_org_mismatch',
         format('need_line=%s warehouse=%s', n.id, n.target_warehouse_id)
    FROM public.central_needs_need_lines n
    JOIN public.warehouses w ON w.id = n.target_warehouse_id
   WHERE n.plan_revision_id = p_plan_revision_id
     AND n.target_warehouse_id IS NOT NULL
     AND w.organization_id IS DISTINCT FROM n.beneficiary_organization_id

  UNION ALL
  -- 9. (212) Defence in depth: a beneficiary that is no longer an eligible
  --    live care institution at review time.
  SELECT 'need_line_beneficiary_ineligible',
         format('need_line=%s beneficiary=%s', n.id, n.beneficiary_organization_id)
    FROM public.central_needs_need_lines n
    JOIN public.organizations o ON o.id = n.beneficiary_organization_id
   WHERE n.plan_revision_id = p_plan_revision_id
     AND (o.organization_kind IS DISTINCT FROM 'care_institution'
          OR o.status IS DISTINCT FROM 'active');
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid) IS
  'CN-2B internal: the single definition of review completeness. Returns one row per unmet submission precondition, empty when the revision is ready. Shared by the submit gate so UI and server can never disagree about what "complete" means. Extended by 212 with operational need-line completeness; no pre-212 branch was removed or weakened.';

-- ----------------------------------------------------------------------------
-- 6. VERIFY — fail the migration rather than ship a half-applied contract.
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  n integer;
BEGIN
  IF to_regclass('public.central_needs_need_lines') IS NULL
     OR to_regclass('public.central_needs_need_line_sources') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): need-line tables missing';
  END IF;

  -- RLS forced on both new tables.
  SELECT count(*) INTO n FROM pg_class
   WHERE oid IN ('public.central_needs_need_lines'::regclass,
                 'public.central_needs_need_line_sources'::regclass)
     AND relrowsecurity AND relforcerowsecurity;
  IF n <> 2 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): RLS not ENABLED+FORCED on both new tables (got %)', n;
  END IF;

  -- No client write grant anywhere on the new surface.
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee = 'authenticated'
     AND table_schema = 'public'
     AND table_name IN ('central_needs_need_lines', 'central_needs_need_line_sources')
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): authenticated holds % direct write grant(s)', n;
  END IF;

  -- anon holds nothing at all.
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee = 'anon'
     AND table_schema = 'public'
     AND table_name IN ('central_needs_need_lines', 'central_needs_need_line_sources');
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): anon holds % grant(s) on the new surface', n;
  END IF;

  -- The accounting-scope key exists exactly as the owner fixed it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.central_needs_need_lines'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) =
           'UNIQUE (plan_revision_id, beneficiary_organization_id, central_item_id)'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): canonical accounting-scope UNIQUE missing';
  END IF;

  -- A source row can feed at most one need line.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.central_needs_need_line_sources'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (import_session_id, target_entity)'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): source-to-one-line UNIQUE missing';
  END IF;

  -- Exact numeric quantity, never float.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'central_needs_need_lines'
       AND column_name = 'approved_quantity'
       AND data_type = 'numeric' AND numeric_precision = 20 AND numeric_scale = 3
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): approved_quantity must be numeric(20,3)';
  END IF;

  -- The write primitive is client-callable; the internal helpers are not.
  IF NOT has_function_privilege('authenticated',
      'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, text, text, uuid, text, jsonb)',
      'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): authenticated cannot execute the need-line write RPC';
  END IF;
  IF has_function_privilege('authenticated',
      'public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): internal beneficiary helper must not be client-callable';
  END IF;
  IF has_function_privilege('anon',
      'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, text, text, uuid, text, jsonb)',
      'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): anon can execute the need-line write RPC';
  END IF;

  -- search_path pinned on every function this migration defines.
  SELECT count(*) INTO n FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('phoenix_central_needs_set_need_line',
                       '_phoenix_central_needs_assert_beneficiary_v1',
                       '_phoenix_central_needs_review_blockers_v1')
     AND NOT EXISTS (
       SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c(v)
        WHERE v = 'search_path=public, pg_temp'
     );
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): % function(s) lack a pinned search_path', n;
  END IF;

  -- The extension preserved every pre-212 blocker branch.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = '_phoenix_central_needs_review_blockers_v1'
       AND pg_get_functiondef(p.oid) LIKE '%no_finalized_import%'
       AND pg_get_functiondef(p.oid) LIKE '%import_session_still_open%'
       AND pg_get_functiondef(p.oid) LIKE '%completed_session_not_in_trusted_batch%'
       AND pg_get_functiondef(p.oid) LIKE '%incomplete_trusted_batch%'
       AND pg_get_functiondef(p.oid) LIKE '%target_entity_without_disposition%'
       AND pg_get_functiondef(p.oid) LIKE '%mapped_target_entity_without_need_line%'
       AND pg_get_functiondef(p.oid) LIKE '%need_line_unit_conversion_required%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): blockers function lost a branch';
  END IF;

  -- No Central Needs permission key was added or removed.
  SELECT count(*) INTO n FROM public.permission_keys WHERE module = 'central_needs';
  IF n <> 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): central_needs permission key count changed (got %)', n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.permission_keys WHERE key = 'central_needs.send') THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): central_needs.send must never exist';
  END IF;

  -- NO BACKFILL. This migration creates no operational need line.
  SELECT count(*) INTO n FROM public.central_needs_need_lines;
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): migration must not create need lines (got %)', n;
  END IF;
END;
$verify$;
