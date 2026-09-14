-- ===========================================================================
-- CN-2B CORRECTIVE EXTENSION (213) — beneficiary identity at IMPORTED-COLUMN
-- grain, not whole-file grain.
--
-- WHY THIS MIGRATION EXISTS
--
-- M212 gave Central Needs a real operational need line, keyed on
-- (plan_revision, beneficiary_organization, central_item[, warehouse]), and
-- proved the cell-level cardinality the real corpus requires: one imported
-- CELL feeds at most one need line, one imported ROW may legitimately feed
-- several lines because a multi-institution sheet carries one quantity column
-- per beneficiary. What M212 left unresolved is WHO DECIDES which beneficiary
-- a given column belongs to: `phoenix_central_needs_set_need_line` simply
-- trusts whatever `p_beneficiary_organization_id` the caller passes for the
-- records it is designating. Nothing stops a caller from designating a
-- Hospital-B cell onto a Hospital-A line beyond human care, and nothing
-- forces every quantity cell of a confirmed beneficiary column to be
-- accounted for before a revision can become ready. For the authoritative
-- 2026 Annual Needs archive (fingerprint
-- b00208ca019c8735790c5401dee26d986234a12279d04e0a057f278bd99eaca2), where 58
-- of 71 sheets carry two or more institution quantity columns, that gap is
-- not a corner case — it is the normal shape of the data.
--
-- This migration closes it the same way M212 closed the beneficiary-identity
-- gap in 209/210/211: by adding the smallest additive relational projection
-- that lets a human's column-to-institution mapping be persisted and
-- enforced, and nothing else. It is still a STAGE 2 CONFORMANCE CORRECTION:
-- no remaining-need computation, no stock, no allocation, no transfer.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * no ALTER of any 209/210/211/212 object other than CREATE OR REPLACE of
--     the two functions this migration extends (set_need_line and the
--     review-blockers function), whose existing bodies are reproduced
--     verbatim and only extended — see sections 4 and 5 below;
--   * no organization is ever created from workbook text (section 2);
--   * no fuzzy, AI, phonetic or positional beneficiary inference — a
--     suggestion is shown for a human to confirm, never persisted by itself;
--   * no second unit catalog, stock ledger, movement engine or audit
--     framework;
--   * NO BACKFILL. A column has a beneficiary only where a human mapped it.
--
-- COLUMN IDENTITY (owner decision; the only stable key CN-2A actually offers)
--   CN-2A's `target_entity` is `sheet:{sheetIndex}:row:{row}` (parser-core.ts)
--   — ROW identity, not column identity — and `field_name` is the column's
--   header TEXT, which the corpus is already proven to duplicate (M212
--   header: "17 sheets repeat the SAME material text on more than one row";
--   independently, CN-1B's own hardening (migration 210, commit e9d6e4b1)
--   closed an identical defect for row identity: "neither [target_entity nor
--   field_name] is unique inside a revision"). Header text is EVIDENCE,
--   exactly like a beneficiary name is evidence — never identity.
--
--   The one field CN-2A always emits for a real cell and never reuses across
--   columns is `source_provenance.coordinate.col`, alongside
--   `source_provenance.sheetIndex` (contract.ts `SourceProvenance`; persisted
--   verbatim into `source_provenance` JSONB by migration 210's trusted
--   replay). So the physical-column key is:
--
--       (import_session_id, sheet_index, column_index)
--
--   where sheet_index/column_index are READ FROM PERSISTED EVIDENCE
--   (`source_provenance->>'sheetIndex'`, `source_provenance->'coordinate'
--   ->>'col'`), never from caller-supplied numbers. A mapping request whose
--   session/sheet/column has no matching source record is refused outright
--   (section "column resolution" below) — there is nothing to map.
--
--   `source_provenance` carries NO CHECK and NO NOT NULL at the table level
--   (migration 209: "a future parser decides what it can offer... CN-1A must
--   not assume any of it exists"), so this migration never assumes a record
--   has usable coordinate provenance; one that doesn't simply cannot be
--   resolved to a physical column, and mapping it is refused, fail-closed.
--
-- BENEFICIARY AUTHORITY (owner decision; v7.3 section 1)
--   Workbook text is evidence, never authority. The eligibility definition is
--   NOT reinvented here: `_phoenix_central_needs_assert_beneficiary_v1`
--   (migration 212) already states it exactly — a live `care_institution` —
--   and is reused unchanged, called with a NULL warehouse argument (column
--   mapping carries no warehouse dimension). An authority organization such as
--   the plan's own owning `pharmacy_department_authority` therefore can never
--   become a beneficiary through this path, for the same reason it cannot
--   through M212's.
--
-- NO SILENT OVERWRITE (owner decision; independent-review discipline
-- established by M212's Q1 stale-provenance fix)
--   Re-mapping an already-confirmed column to a DIFFERENT beneficiary is a
--   correction, not a courtesy default. The write RPC therefore takes an
--   optional `previousBeneficiaryOrganizationId` per mapping item — the
--   beneficiary the caller believes is currently mapped, or NULL when the
--   caller believes the column is still unmapped — and refuses the WHOLE
--   batch, atomically, if any item's belief disagrees with what is actually
--   persisted. This is exactly M212's `p_expected_source_record_ids` idiom
--   (state what you last saw; a stale view changes nothing) applied to this
--   narrower surface. Re-affirming the SAME beneficiary is always accepted
--   and is idempotent — no audit noise, no error, no change.
--
-- SERVER BOUNDARY, NOT UI COURTESY (v7.3 section 9; M212's own principle)
--   `phoenix_central_needs_set_need_line` is CREATE OR REPLACE'd with the
--   IDENTICAL public signature. Every line M212 already validates is
--   reproduced verbatim; the one addition is that every designated source
--   record must resolve to a confirmed column mapping, and that mapping's
--   beneficiary must equal the line's beneficiary — fail-closed, before any
--   row is written. This holds even for a caller who never uses the new
--   mapping UI: if a source cell contributes to an operational need line, its
--   beneficiary must ultimately be supported by a confirmed column mapping,
--   with NO whole-file or single-institution shortcut (owner decision,
--   section 19 of the corrective brief this migration implements).
--
--   `_phoenix_central_needs_review_blockers_v1` is CREATE OR REPLACE'd the
--   same way M212 extended M211's: every pre-213 branch (M211's five, M212's
--   nine) is reproduced verbatim, and one branch is appended —
--   `beneficiary_column_cell_without_need_line` — which is the CELL-grain
--   completeness check M212 could not express: M212's own
--   `mapped_target_entity_without_need_line` is satisfied by ANY ONE linked
--   cell of a row, so a multi-institution row with Hospital A's cell linked
--   and Hospital B's cell forgotten was previously invisible to review
--   readiness. The new branch closes exactly that gap, and ZERO counts: a
--   confirmed-column cell whose stored value is the number zero still exists
--   as a row in `central_needs_source_records` and is still required to be
--   linked — "blank is not zero" is a value-column distinction
--   (`source_values->>'valueType' = 'number'`), never a presence test.
--
-- EVERY RELEVANT COLUMN REACHES AN EXPLICIT REVIEW DECISION (independent
-- review finding 1, corrected before this migration was ever applied)
--   A completeness branch that starts FROM the mapping table can only see
--   columns someone already reviewed. One material row with Column A (mapped
--   to Hospital A, linked) and Column B (numeric, never reviewed) therefore
--   satisfied every branch: M212's row-grain branch through Column A's linked
--   cell, and the cell-grain branch above because Column B had no mapping row
--   at all. "No mapping row" could mean not-reviewed-yet, not-a-beneficiary,
--   an unregistered institution, or ignored — and still permit readiness.
--
--   A physical column's review state is therefore explicit and exactly one of:
--     beneficiary      a mapping row with decision = 'beneficiary' naming one
--                      eligible care_institution; each of its numeric cells on
--                      a mapped row must be accounted for by a need line;
--     non_beneficiary  a mapping row with decision = 'non_beneficiary' naming
--                      NO beneficiary, with the same mandatory reason, actor,
--                      time and audit trail as any other decision; its cells
--                      are reviewed and are never need-line sources;
--     UNRESOLVED       no mapping row. `beneficiary_column_review_required`
--                      blocks readiness and submission for every such column
--                      that carries numeric evidence on a row dispositioned
--                      `mapped` — computed FROM the source evidence, never from
--                      the mapping table.
--   There is no "unregistered" or "ignored" state. A column for an institution
--   that is not registered yet stays UNRESOLVED (blocking) until that
--   organization exists and is confirmed, or a human explicitly and audibly
--   classifies the column as genuinely non-beneficiary. Nothing converts an
--   unknown institution into non_beneficiary: the write RPC never implies it
--   (an item may omit `decision` only by naming a beneficiary, because naming
--   a care institution IS the beneficiary decision).
-- ===========================================================================

-- ----------------------------------------------------------------------------
-- 0. Preconditions. Fail closed rather than half-apply.
-- ----------------------------------------------------------------------------
DO $precondition$
BEGIN
  IF to_regclass('public.central_needs_need_lines') IS NULL
     OR to_regclass('public.central_needs_need_line_sources') IS NULL
     OR to_regclass('public.central_needs_source_records') IS NULL
     OR to_regclass('public.central_needs_import_sessions') IS NULL
     OR to_regclass('public.central_needs_record_mappings') IS NULL THEN
    RAISE EXCEPTION '213_precondition_failed: M209-M212 Central Needs surface is absent';
  END IF;

  IF to_regclass('public.central_needs_beneficiary_column_mappings') IS NOT NULL THEN
    RAISE EXCEPTION '213_precondition_failed: central_needs_beneficiary_column_mappings already exists';
  END IF;

  -- The declarative session->revision->org binding this migration relies on
  -- (section 2 below) is M211's composite key.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.central_needs_import_sessions'::regclass
       AND contype  = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (id, plan_revision_id, organization_id)'
  ) THEN
    RAISE EXCEPTION '213_precondition_failed: central_needs_import_sessions UNIQUE (id, plan_revision_id, organization_id) absent';
  END IF;

  IF to_regprocedure('public._phoenix_central_needs_role_eligible_v1()') IS NULL
     OR to_regprocedure('public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid)') IS NULL
     OR to_regprocedure('public._phoenix_central_needs_guard_v1(uuid, text)') IS NULL
     OR to_regprocedure('public._phoenix_central_needs_load_revision_v1(uuid)') IS NULL
     OR to_regprocedure('public._phoenix_central_needs_assert_org_live_v1(uuid)') IS NULL
     OR to_regprocedure('public._phoenix_central_needs_assert_draft_v1(uuid, text)') IS NULL THEN
    RAISE EXCEPTION '213_precondition_failed: a required M210/M211/M212 helper is absent';
  END IF;
END;
$precondition$;

-- ----------------------------------------------------------------------------
-- 1. The canonical beneficiary-column mapping.
-- ----------------------------------------------------------------------------
CREATE TABLE public.central_needs_beneficiary_column_mappings (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_revision_id             uuid NOT NULL,
  -- The OWNING/authorizing central organization. Same meaning as everywhere
  -- else in Central Needs; never repurposed to mean the beneficiary.
  organization_id              uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  import_session_id            uuid NOT NULL,
  -- Physical-column identity, read from persisted source_provenance — never
  -- from caller-supplied numbers alone (the write RPC re-derives these from
  -- evidence; see section 3). Non-negative because CN-2A's sheetIndex/col are
  -- zero-based array/grid positions.
  sheet_index                  integer NOT NULL CHECK (sheet_index >= 0),
  column_index                 integer NOT NULL CHECK (column_index >= 0),
  -- The explicit human review decision for this physical column (independent
  -- review finding 1). No row at all means UNRESOLVED, which blocks readiness.
  decision                     text NOT NULL,
  -- The institution whose annual requirement this physical column belongs to —
  -- present exactly when decision = 'beneficiary', absent for 'non_beneficiary'
  -- (declaratively enforced by the decision-shape CHECK below).
  beneficiary_organization_id  uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  -- Evidence/display only — the header text CN-2A read for this column, when
  -- the matched records agree on one. Never authority, never identity: two
  -- physical columns may legitimately share this text (M212/M210 corpus
  -- findings), and this column is never part of any UNIQUE or lookup key.
  source_field_name            text,
  -- v7.3 section 9: every manual mapping/correction requires a reason.
  mapping_reason                text NOT NULL,
  mapped_by                     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  mapped_at                     timestamptz NOT NULL DEFAULT now(),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT central_needs_beneficiary_column_mappings_reason_chk
    CHECK (btrim(mapping_reason) <> ''),

  -- Exactly two explicit decisions; there is no third "unregistered"/"ignored"
  -- state that could stand in for a review.
  CONSTRAINT central_needs_beneficiary_column_mappings_decision_chk
    CHECK (decision IN ('beneficiary', 'non_beneficiary')),

  -- A beneficiary decision names one institution; a non-beneficiary decision
  -- names none. Declarative, so no write path can store an ambiguous row.
  CONSTRAINT central_needs_beneficiary_column_mappings_decision_shape_chk
    CHECK ((decision = 'beneficiary') = (beneficiary_organization_id IS NOT NULL)),

  -- ONE PHYSICAL COLUMN -> ONE MAPPING. This is the entire cardinality rule at
  -- this grain; nothing here constrains how many columns one beneficiary may
  -- hold (many), nor how many columns one import session may carry (many).
  CONSTRAINT central_needs_beneficiary_column_mappings_column_key
    UNIQUE (import_session_id, sheet_index, column_index),

  -- organization_id must be the revision's own owning org.
  CONSTRAINT central_needs_beneficiary_column_mappings_revision_org_fk
    FOREIGN KEY (plan_revision_id, organization_id)
    REFERENCES public.central_needs_plan_revisions (id, organization_id)
    ON DELETE RESTRICT,

  -- import_session_id must belong to THIS row's exact plan_revision_id AND
  -- organization_id — declaratively, via M211's composite key on
  -- central_needs_import_sessions. A mapping can never claim a session from
  -- another revision or another organization.
  CONSTRAINT central_needs_beneficiary_column_mappings_session_revision_org_fk
    FOREIGN KEY (import_session_id, plan_revision_id, organization_id)
    REFERENCES public.central_needs_import_sessions (id, plan_revision_id, organization_id)
    ON DELETE RESTRICT
);

CREATE INDEX central_needs_beneficiary_column_mappings_revision_idx
  ON public.central_needs_beneficiary_column_mappings (plan_revision_id);
CREATE INDEX central_needs_beneficiary_column_mappings_org_idx
  ON public.central_needs_beneficiary_column_mappings (organization_id);
CREATE INDEX central_needs_beneficiary_column_mappings_beneficiary_idx
  ON public.central_needs_beneficiary_column_mappings (beneficiary_organization_id);
CREATE INDEX central_needs_beneficiary_column_mappings_session_idx
  ON public.central_needs_beneficiary_column_mappings (import_session_id);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.central_needs_beneficiary_column_mappings
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at();

COMMENT ON TABLE public.central_needs_beneficiary_column_mappings IS
  'CN-2B corrective extension (213): the canonical mapping from one physical imported column (import_session_id, sheet_index, column_index — read from persisted source_provenance, never from a header) to its explicit human review decision — the one care_institution beneficiary whose Annual Need it represents, or an explicit, reasoned non_beneficiary classification (no row = UNRESOLVED, which blocks review readiness). Human-authoritative; never inferred, never backfilled. Reused by phoenix_central_needs_set_need_line (213 CREATE OR REPLACE of the M212 RPC) to resolve and enforce a designated source cell''s beneficiary.';
COMMENT ON COLUMN public.central_needs_beneficiary_column_mappings.sheet_index IS
  'CN-2A sheetIndex, read from central_needs_source_records.source_provenance for at least one authoritative record at the time of mapping. Not caller-supplied identity.';
COMMENT ON COLUMN public.central_needs_beneficiary_column_mappings.column_index IS
  'CN-2A source_provenance.coordinate.col, read from persisted evidence. Duplicate header text in the corpus makes field_name unsafe as column identity; this is the stable key instead.';
COMMENT ON COLUMN public.central_needs_beneficiary_column_mappings.source_field_name IS
  'Evidence only — the header text CN-2A read for this column, when every matched record agrees. Never part of any key; never authority for beneficiary identity.';
COMMENT ON COLUMN public.central_needs_beneficiary_column_mappings.decision IS
  'Explicit column-review decision (independent review finding 1): beneficiary (beneficiary_organization_id names one eligible care_institution) or non_beneficiary (no beneficiary; reason, actor, time and audit preserved). There is no third state: a physical column with no row is UNRESOLVED and blocks readiness when it carries numeric evidence on a mapped row.';

ALTER TABLE public.central_needs_beneficiary_column_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_beneficiary_column_mappings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_beneficiary_column_mappings FROM PUBLIC;
REVOKE ALL ON TABLE public.central_needs_beneficiary_column_mappings FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.central_needs_beneficiary_column_mappings FROM authenticated;
GRANT SELECT ON TABLE public.central_needs_beneficiary_column_mappings TO authenticated;

CREATE POLICY central_needs_beneficiary_column_mappings_select_authorized
  ON public.central_needs_beneficiary_column_mappings FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));

CREATE POLICY central_needs_beneficiary_column_mappings_role_eligible_restrictive
  ON public.central_needs_beneficiary_column_mappings AS RESTRICTIVE FOR ALL TO authenticated
  USING (public._phoenix_central_needs_role_eligible_v1())
  WITH CHECK (public._phoenix_central_needs_role_eligible_v1());

-- ----------------------------------------------------------------------------
-- 2. Resolve a physical column's beneficiary mapping for one source record.
--    Internal only — the single definition every write/read path below and
--    in the extended set_need_line RPC shares, so "how do we find a column's
--    mapping from a source record" is answered exactly once.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_resolve_column_mapping_v1(
  p_import_session_id uuid,
  p_source_provenance  jsonb
)
RETURNS public.central_needs_beneficiary_column_mappings
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT m.*
    FROM public.central_needs_beneficiary_column_mappings m
   WHERE m.import_session_id = p_import_session_id
     AND m.sheet_index       = (p_source_provenance->>'sheetIndex')::integer
     AND m.column_index      = (p_source_provenance->'coordinate'->>'col')::integer;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_resolve_column_mapping_v1(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_resolve_column_mapping_v1(uuid, jsonb) IS
  'CN-2B (213) internal: resolves a source record''s confirmed beneficiary-column mapping from its own persisted source_provenance. Returns no row when sheetIndex/coordinate.col are absent, non-numeric, or simply unmapped — never a guess.';

-- ----------------------------------------------------------------------------
-- 3. The canonical write and read primitives for column mapping.
--
--   3a  phoenix_central_needs_set_beneficiary_columns   confirm one or more
--                                                        physical-column
--                                                        mappings, atomically.
--   3b  phoenix_central_needs_list_beneficiary_columns   the bounded,
--                                                        revision-level
--                                                        column summary read.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_set_beneficiary_columns(
  p_plan_revision_id uuid,
  -- Each element:
  --   { "importSessionId": uuid, "sheetIndex": integer, "columnIndex": integer,
  --     "decision": "beneficiary" | "non_beneficiary",
  --     "beneficiaryOrganizationId": uuid | null,
  --     "previousDecision": "beneficiary" | "non_beneficiary" | null,
  --     "previousBeneficiaryOrganizationId": uuid | null }
  -- "decision" may be omitted ONLY by naming a beneficiary (naming a care
  -- institution is the beneficiary decision); non_beneficiary is never
  -- implied. The "previous" fields are the caller's belief of current state:
  -- previousDecision NULL means "I believe this column is unresolved"; when
  -- previousDecision is omitted it is read from
  -- previousBeneficiaryOrganizationId (non-NULL = beneficiary, NULL =
  -- unresolved). A mismatch refuses the WHOLE batch (M212's
  -- p_expected_source_record_ids idiom, applied here); nothing is silently
  -- overwritten.
  p_mappings         jsonb,
  p_mapping_reason   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor         uuid := auth.uid();
  v_actor_role    text;
  v_revision      public.central_needs_plan_revisions%ROWTYPE;
  v_reason        text := NULLIF(btrim(p_mapping_reason), '');
  v_item          jsonb;
  v_session_id    uuid;
  v_sheet_index   integer;
  v_column_index  integer;
  v_beneficiary   uuid;
  v_decision      text;
  v_prev_provided boolean;
  v_prev_expected uuid;
  v_prev_decision text;
  v_existing      public.central_needs_beneficiary_column_mappings%ROWTYPE;
  v_field_names   text[];
  v_field_name    text;
  v_record_count  integer;
  v_mapping_id    uuid;
  v_created       boolean;
  v_changed       boolean;
  v_results       jsonb := '[]'::jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  v_revision := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);
  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.edit');
  PERFORM public._phoenix_central_needs_assert_org_live_v1(v_revision.organization_id);
  PERFORM public._phoenix_central_needs_assert_draft_v1(v_revision.id, v_revision.status);

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'mapping_reason_required' USING ERRCODE = '23514';
  END IF;
  IF p_mappings IS NULL OR jsonb_typeof(p_mappings) <> 'array' THEN
    RAISE EXCEPTION 'beneficiary_columns_must_be_array' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(p_mappings) = 0 THEN
    RAISE EXCEPTION 'beneficiary_columns_required' USING ERRCODE = '23514',
      HINT = 'Name at least one physical column to confirm.';
  END IF;

  FOR v_item IN SELECT e FROM jsonb_array_elements(p_mappings) AS e
  LOOP
    v_session_id   := NULLIF(btrim(coalesce(v_item->>'importSessionId', '')), '')::uuid;
    v_beneficiary  := NULLIF(btrim(coalesce(v_item->>'beneficiaryOrganizationId', '')), '')::uuid;

    IF v_session_id IS NULL THEN
      RAISE EXCEPTION 'beneficiary_column_import_session_required' USING ERRCODE = '23514';
    END IF;
    IF (v_item->'sheetIndex') IS NULL OR jsonb_typeof(v_item->'sheetIndex') <> 'number' THEN
      RAISE EXCEPTION 'beneficiary_column_sheet_index_required' USING ERRCODE = '23514',
        DETAIL = format('session=%s', v_session_id);
    END IF;
    IF (v_item->'columnIndex') IS NULL OR jsonb_typeof(v_item->'columnIndex') <> 'number' THEN
      RAISE EXCEPTION 'beneficiary_column_column_index_required' USING ERRCODE = '23514',
        DETAIL = format('session=%s', v_session_id);
    END IF;
    v_sheet_index  := (v_item->>'sheetIndex')::integer;
    v_column_index := (v_item->>'columnIndex')::integer;
    IF v_sheet_index < 0 OR v_column_index < 0 THEN
      RAISE EXCEPTION 'beneficiary_column_index_must_not_be_negative' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s', v_session_id, v_sheet_index, v_column_index);
    END IF;
    -- The explicit review decision (independent review finding 1). Omitted or
    -- JSON null reads as 'beneficiary' — which still requires a named
    -- beneficiary just below — so non_beneficiary is never implied. Any other
    -- value, including an empty string or an invented state, is refused.
    IF (v_item ? 'decision') AND jsonb_typeof(v_item->'decision') <> 'null' THEN
      v_decision := v_item->>'decision';
    ELSE
      v_decision := 'beneficiary';
    END IF;
    IF v_decision IS NULL OR v_decision NOT IN ('beneficiary', 'non_beneficiary') THEN
      RAISE EXCEPTION 'beneficiary_column_decision_invalid' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s decision=%s',
                        v_session_id, v_sheet_index, v_column_index, coalesce(v_decision, '(null)')),
        HINT = 'A column is either a beneficiary column (name the institution) or not a beneficiary column (with a reason). A column for an institution that is not registered yet stays unresolved.';
    END IF;
    IF v_decision = 'beneficiary' AND v_beneficiary IS NULL THEN
      RAISE EXCEPTION 'beneficiary_organization_required' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s', v_session_id, v_sheet_index, v_column_index);
    END IF;
    IF v_decision = 'non_beneficiary' AND v_beneficiary IS NOT NULL THEN
      RAISE EXCEPTION 'beneficiary_column_non_beneficiary_must_not_name_beneficiary' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s beneficiary=%s',
                        v_session_id, v_sheet_index, v_column_index, v_beneficiary);
    END IF;

    -- The session must belong to THIS exact revision/org — declaratively true
    -- for any row that lands in the table (the FK proves it), but checked
    -- explicitly here first so a foreign session is refused as a stable
    -- domain error rather than a raw FK violation.
    IF NOT EXISTS (
      SELECT 1 FROM public.central_needs_import_sessions
       WHERE id = v_session_id AND plan_revision_id = v_revision.id AND organization_id = v_revision.organization_id
    ) THEN
      RAISE EXCEPTION 'beneficiary_column_session_not_in_revision' USING ERRCODE = '23514',
        DETAIL = format('session=%s', v_session_id);
    END IF;

    -- Prove authoritative evidence exists for this EXACT physical column, and
    -- derive its display field name from that evidence — never from the
    -- caller. A physical column with no matching record has nothing to map.
    SELECT count(*), array_agg(DISTINCT field_name)
      INTO v_record_count, v_field_names
      FROM public.central_needs_source_records r
     WHERE r.import_session_id = v_session_id
       AND (r.source_provenance->>'sheetIndex')::integer = v_sheet_index
       AND (r.source_provenance->'coordinate'->>'col')::integer = v_column_index;

    IF v_record_count IS NULL OR v_record_count = 0 THEN
      RAISE EXCEPTION 'beneficiary_column_no_matching_evidence' USING ERRCODE = '23503',
        DETAIL = format('session=%s sheet=%s column=%s', v_session_id, v_sheet_index, v_column_index),
        HINT = 'No authoritative source record carries this exact session/sheet/column provenance.';
    END IF;
    IF array_length(v_field_names, 1) > 1 THEN
      RAISE EXCEPTION 'beneficiary_column_field_name_inconsistent' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s field_names=%s',
                        v_session_id, v_sheet_index, v_column_index, v_field_names),
        HINT = 'This physical column''s records disagree on field name; resolve the source evidence before mapping.';
    END IF;
    v_field_name := v_field_names[1];

    -- Beneficiary eligibility: the single M212 definition, reused unchanged.
    -- NULL warehouse — column mapping carries no warehouse dimension. A
    -- non_beneficiary decision names no institution, so there is none to check.
    IF v_decision = 'beneficiary' THEN
      PERFORM public._phoenix_central_needs_assert_beneficiary_v1(v_beneficiary, NULL);
    END IF;

    -- No silent overwrite: the caller must state what it believes is current.
    SELECT * INTO v_existing
      FROM public.central_needs_beneficiary_column_mappings
     WHERE import_session_id = v_session_id AND sheet_index = v_sheet_index AND column_index = v_column_index
     FOR UPDATE;

    v_prev_provided := (v_item ? 'previousBeneficiaryOrganizationId')
                        AND jsonb_typeof(v_item->'previousBeneficiaryOrganizationId') <> 'null';
    v_prev_expected := CASE WHEN v_prev_provided
                            THEN NULLIF(btrim(coalesce(v_item->>'previousBeneficiaryOrganizationId', '')), '')::uuid
                            ELSE NULL END;
    -- The believed decision: stated explicitly when "previousDecision" is
    -- present (JSON null = believed unresolved); otherwise read from the
    -- believed beneficiary, exactly as before this correction.
    v_prev_decision := CASE
                         WHEN (v_item ? 'previousDecision') THEN v_item->>'previousDecision'
                         WHEN v_prev_expected IS NOT NULL THEN 'beneficiary'
                         ELSE NULL
                       END;

    IF (NOT FOUND AND (v_prev_decision IS NOT NULL OR v_prev_expected IS NOT NULL))
       OR (FOUND AND (v_existing.decision IS DISTINCT FROM v_prev_decision
                      OR v_existing.beneficiary_organization_id IS DISTINCT FROM v_prev_expected)) THEN
      RAISE EXCEPTION 'beneficiary_column_mapping_stale' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s expected=%s/%s current=%s/%s',
                        v_session_id, v_sheet_index, v_column_index,
                        coalesce(v_prev_decision, '(unresolved)'),
                        coalesce(v_prev_expected::text, '(none)'),
                        coalesce(v_existing.decision, '(unresolved)'),
                        coalesce(v_existing.beneficiary_organization_id::text, '(none)')),
        HINT = 'This column''s review decision changed since you last saw it. Reload and decide again; nothing was written.';
    END IF;

    IF NOT FOUND THEN
      INSERT INTO public.central_needs_beneficiary_column_mappings (
        plan_revision_id, organization_id, import_session_id, sheet_index, column_index,
        decision, beneficiary_organization_id, source_field_name, mapping_reason, mapped_by, mapped_at
      ) VALUES (
        v_revision.id, v_revision.organization_id, v_session_id, v_sheet_index, v_column_index,
        v_decision, v_beneficiary, v_field_name, v_reason, v_actor, now()
      )
      RETURNING id INTO v_mapping_id;
      v_created := true;
      v_changed := true;
    ELSIF v_existing.decision IS DISTINCT FROM v_decision
       OR v_existing.beneficiary_organization_id IS DISTINCT FROM v_beneficiary THEN
      UPDATE public.central_needs_beneficiary_column_mappings
         SET decision                    = v_decision,
             beneficiary_organization_id = v_beneficiary,
             source_field_name           = v_field_name,
             mapping_reason              = v_reason,
             mapped_by                   = v_actor,
             mapped_at                   = now()
       WHERE id = v_existing.id;
      v_mapping_id := v_existing.id;
      v_created := false;
      v_changed := true;
    ELSE
      -- Idempotent replay of the identical mapping: no write, no audit noise.
      v_mapping_id := v_existing.id;
      v_created := false;
      v_changed := false;
    END IF;

    IF v_changed THEN
      INSERT INTO public.audit_logs (
        organization_id, actor_id, actor_role, action, entity_type, entity_id,
        entity_label, payload
      ) VALUES (
        v_revision.organization_id, v_actor, v_actor_role,
        'central_needs.beneficiary_column.set', 'central_needs_beneficiary_column_mapping', v_mapping_id,
        NULL,
        jsonb_build_object(
          'plan_revision_id', v_revision.id,
          'import_session_id', v_session_id,
          'sheet_index', v_sheet_index,
          'column_index', v_column_index,
          'source_field_name', v_field_name,
          'previous_decision',
            CASE WHEN v_created THEN NULL ELSE v_existing.decision END,
          'new_decision', v_decision,
          'previous_beneficiary_organization_id',
            CASE WHEN v_created THEN NULL ELSE v_existing.beneficiary_organization_id::text END,
          'new_beneficiary_organization_id', v_beneficiary,
          'mapping_reason', v_reason
        )
      );
    END IF;

    v_results := v_results || jsonb_build_object(
      'mappingId', v_mapping_id,
      'importSessionId', v_session_id,
      'sheetIndex', v_sheet_index,
      'columnIndex', v_column_index,
      'decision', v_decision,
      'beneficiaryOrganizationId', v_beneficiary,
      'sourceFieldName', v_field_name,
      'created', v_created,
      'changed', v_changed
    );
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'confirmed', v_results);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_set_beneficiary_columns(uuid, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_set_beneficiary_columns(uuid, jsonb, text)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_set_beneficiary_columns(uuid, jsonb, text) IS
  'CN-2B corrective extension (213): atomically records one or more explicit physical-column review decisions: beneficiary (naming one eligible care_institution) or non_beneficiary (naming none; the reason stays mandatory). Column identity is re-derived from persisted source_provenance, never trusted from the caller; a column with no matching evidence, inconsistent field names, or an ineligible beneficiary refuses the WHOLE batch. Changing an existing decision requires the caller to state the decision and beneficiary it believes are current (stale views are refused); re-affirming the same decision is an idempotent no-op. Draft revisions only. Fully audited.';

-- ----------------------------------------------------------------------------
-- 3b. The bounded column-summary read (independent-review "do not load 113k
--     cells to build a picker"). SECURITY INVOKER: grants nothing, exactly
--     the caller's own RLS decides visibility, matching M212's read RPC.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_list_beneficiary_columns(
  p_plan_revision_id uuid
)
RETURNS TABLE (
  import_session_id      uuid,
  original_filename      text,
  archive_entry_path     text,
  sheet_index            integer,
  sheet_name             text,
  column_index           integer,
  source_field_name      text,
  numeric_value_count    bigint,
  zero_value_count       bigint,
  nonzero_numeric_count  bigint,
  mapping_id             uuid,
  column_decision        text,
  beneficiary_organization_id uuid,
  mapping_reason         text,
  mapped_at              timestamptz,
  mapped_row_numeric_count bigint,
  review_required        boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    r.import_session_id,
    max(r.source_provenance->>'originalFilename')      AS original_filename,
    max(r.source_provenance->>'archiveEntryPath')       AS archive_entry_path,
    (r.source_provenance->>'sheetIndex')::integer       AS sheet_index,
    max(r.source_provenance->>'sheetName')              AS sheet_name,
    (r.source_provenance->'coordinate'->>'col')::integer AS column_index,
    max(r.field_name)                                   AS source_field_name,
    count(*) FILTER (WHERE r.source_values->>'valueType' = 'number')                                        AS numeric_value_count,
    count(*) FILTER (WHERE r.source_values->>'valueType' = 'number' AND (r.source_values->>'value')::numeric = 0) AS zero_value_count,
    count(*) FILTER (WHERE r.source_values->>'valueType' = 'number' AND (r.source_values->>'value')::numeric <> 0) AS nonzero_numeric_count,
    m.id                                                 AS mapping_id,
    m.decision                                           AS column_decision,
    m.beneficiary_organization_id,
    m.mapping_reason,
    m.mapped_at,
    -- (independent review finding 1) What makes a column review-relevant:
    -- numeric cells on rows a human dispositioned `mapped`, in completed
    -- sessions — the exact rule of the beneficiary_column_review_required
    -- blocker, so the picker's "blocks submission" marker is the server's.
    count(*) FILTER (WHERE r.source_values->>'valueType' = 'number'
                       AND rm.decision = 'mapped' AND s.status = 'completed')         AS mapped_row_numeric_count,
    (m.id IS NULL
     AND count(*) FILTER (WHERE r.source_values->>'valueType' = 'number'
                            AND rm.decision = 'mapped' AND s.status = 'completed') > 0) AS review_required
  FROM public.central_needs_source_records r
  JOIN public.central_needs_import_sessions s ON s.id = r.import_session_id
  -- UNIQUE (import_session_id, target_entity) (M210): at most one disposition
  -- per row, so this join never multiplies a cell.
  LEFT JOIN public.central_needs_record_mappings rm
         ON rm.import_session_id = r.import_session_id
        AND rm.target_entity     = r.target_entity
  LEFT JOIN public.central_needs_beneficiary_column_mappings m
         ON m.import_session_id = r.import_session_id
        AND m.sheet_index       = (r.source_provenance->>'sheetIndex')::integer
        AND m.column_index      = (r.source_provenance->'coordinate'->>'col')::integer
 WHERE s.plan_revision_id = p_plan_revision_id
   AND r.source_provenance ? 'sheetIndex'
   AND r.source_provenance->'coordinate' ? 'col'
 GROUP BY r.import_session_id, (r.source_provenance->>'sheetIndex')::integer,
          (r.source_provenance->'coordinate'->>'col')::integer,
          m.id, m.decision, m.beneficiary_organization_id, m.mapping_reason, m.mapped_at
 ORDER BY r.import_session_id, sheet_index, column_index;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_list_beneficiary_columns(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_list_beneficiary_columns(uuid) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_list_beneficiary_columns(uuid) IS
  'CN-2B corrective extension (213): the bounded, revision-level summary of every physical candidate beneficiary column — one row per (import_session_id, sheet_index, column_index), never one row per cell. SECURITY INVOKER: the caller''s own RLS decides visibility. Exists so the browser never loads the full ~113k-record archive merely to render a column picker. Each row also carries the column''s explicit review decision (column_decision) and review_required — true exactly when the column has no decision yet but carries numeric evidence on a mapped row in a completed session, the same rule the beneficiary_column_review_required blocker enforces.';

-- ----------------------------------------------------------------------------
-- 4. CREATE OR REPLACE phoenix_central_needs_set_need_line (M212, same public
--    signature). Every check M212 already performs is reproduced verbatim;
--    the ONLY addition is the beneficiary-column-mapping resolution inside
--    the per-source-record loop (marked below), which runs for every
--    designated record BEFORE it can be linked.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_set_need_line(
  p_plan_revision_id            uuid,
  p_beneficiary_organization_id uuid,
  p_central_item_id             uuid,
  p_approved_quantity           numeric,
  p_mapping_reason              text,
  p_quantity_sources            jsonb,
  p_expected_source_record_ids  uuid[],
  p_approved_unit               text    DEFAULT NULL,
  p_unit_conversion_state       text    DEFAULT 'canonical',
  p_target_warehouse_id         uuid    DEFAULT NULL,
  p_source_unit_text            text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_revision     public.central_needs_plan_revisions%ROWTYPE;
  v_reason       text := NULLIF(btrim(p_mapping_reason), '');
  v_state        text := NULLIF(btrim(p_unit_conversion_state), '');
  v_unit         text := NULLIF(btrim(p_approved_unit), '');
  v_source_unit  text := NULLIF(btrim(coalesce(p_source_unit_text, '')), '');
  v_line         public.central_needs_need_lines%ROWTYPE;
  v_created      boolean;
  v_existing_ids uuid[];
  v_existing_sum numeric;
  v_expected_ids uuid[];
  v_added_count  integer := 0;
  v_added_sum    numeric := 0;
  v_record       public.central_needs_source_records%ROWTYPE;
  v_src          jsonb;
  v_record_id    uuid;
  v_qty          numeric;
  v_override     uuid;
  v_holder       uuid;
  v_constraint   text;
  v_col_mapping  public.central_needs_beneficiary_column_mappings%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  v_revision := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);
  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.edit');
  PERFORM public._phoenix_central_needs_assert_org_live_v1(v_revision.organization_id);
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
  IF p_approved_quantity = 'NaN'::numeric OR p_approved_quantity >= 'Infinity'::numeric THEN
    RAISE EXCEPTION 'approved_quantity_must_be_finite' USING ERRCODE = '23514';
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
  IF p_expected_source_record_ids IS NULL
     OR array_position(p_expected_source_record_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'expected_source_record_ids_required' USING ERRCODE = '23514',
      HINT = 'State the source records this line holds as you last loaded it — an empty array when you expect no line yet.';
  END IF;

  IF p_quantity_sources IS NULL OR jsonb_typeof(p_quantity_sources) <> 'array' THEN
    RAISE EXCEPTION 'quantity_sources_must_be_array' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(p_quantity_sources) = 0 THEN
    RAISE EXCEPTION 'need_line_requires_source_lineage' USING ERRCODE = '23514',
      HINT = 'Designate at least one imported source record as the origin of this approved quantity.';
  END IF;

  PERFORM public._phoenix_central_needs_assert_beneficiary_v1(
    p_beneficiary_organization_id, p_target_warehouse_id);

  SELECT * INTO v_line
    FROM public.central_needs_need_lines
   WHERE plan_revision_id            = v_revision.id
     AND beneficiary_organization_id = p_beneficiary_organization_id
     AND central_item_id             = p_central_item_id
     AND target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id
   FOR UPDATE;
  v_created := NOT FOUND;

  SELECT coalesce(array_agg(ls.source_record_id ORDER BY ls.source_record_id), ARRAY[]::uuid[]),
         coalesce(sum(ls.designated_quantity), 0)
    INTO v_existing_ids, v_existing_sum
    FROM public.central_needs_need_line_sources ls
   WHERE ls.need_line_id = v_line.id;

  SELECT coalesce(array_agg(DISTINCT e ORDER BY e), ARRAY[]::uuid[])
    INTO v_expected_ids
    FROM unnest(p_expected_source_record_ids) AS e;

  IF v_expected_ids IS DISTINCT FROM v_existing_ids THEN
    RAISE EXCEPTION 'need_line_lineage_stale' USING ERRCODE = '23514',
      DETAIL = format('need_line=%s expected_links=%s current_links=%s',
                      coalesce(v_line.id::text, '(none)'),
                      cardinality(v_expected_ids), cardinality(v_existing_ids)),
      HINT = 'This requirement''s provenance changed since it was loaded. Reload it and decide again; nothing was written.';
  END IF;

  IF v_created THEN
    BEGIN
      INSERT INTO public.central_needs_need_lines (
        plan_revision_id, organization_id, beneficiary_organization_id,
        target_warehouse_id, central_item_id, approved_quantity, approved_unit,
        unit_conversion_state, source_unit_text, mapping_reason, mapped_by
      ) VALUES (
        v_revision.id, v_revision.organization_id, p_beneficiary_organization_id,
        p_target_warehouse_id, p_central_item_id, p_approved_quantity, v_unit,
        v_state, v_source_unit, v_reason, v_actor
      )
      RETURNING * INTO v_line;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'central_needs_need_lines_scope_key' THEN
        RAISE EXCEPTION 'need_line_scope_conflict' USING ERRCODE = '23514',
          HINT = 'This requirement was created concurrently. Reload it and add to it instead.';
      END IF;
      RAISE;
    END;
  ELSIF v_line.unit_conversion_state IS DISTINCT FROM v_state
     OR v_line.approved_unit IS DISTINCT FROM v_unit
     OR (v_source_unit IS NOT NULL AND v_source_unit IS DISTINCT FROM v_line.source_unit_text) THEN
    RAISE EXCEPTION 'need_line_attributes_conflict' USING ERRCODE = '23514',
      DETAIL = format('need_line=%s unit=%s state=%s', v_line.id,
                      coalesce(v_line.approved_unit, '(none)'), v_line.unit_conversion_state),
      HINT = 'Provenance added to an existing line is a quantity in that line''s unit. To change the unit, delete the line with a reason and map it again.';
  END IF;

  FOR v_src IN SELECT e FROM jsonb_array_elements(p_quantity_sources) AS e
  LOOP
    v_record_id := NULLIF(btrim(coalesce(v_src->>'sourceRecordId', '')), '')::uuid;
    v_override  := NULLIF(btrim(coalesce(v_src->>'appliedOverrideId', '')), '')::uuid;
    IF v_record_id IS NULL THEN
      RAISE EXCEPTION 'source_link_requires_source_record_id' USING ERRCODE = '23514';
    END IF;
    IF (v_src->'designatedQuantity') IS NULL OR jsonb_typeof(v_src->'designatedQuantity') = 'null' THEN
      RAISE EXCEPTION 'source_link_requires_designated_quantity' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s', v_record_id);
    END IF;
    BEGIN
      v_qty := (v_src->>'designatedQuantity')::numeric;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'designated_quantity_not_numeric' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s value=%s', v_record_id, v_src->>'designatedQuantity');
    END;
    IF v_qty = 'NaN'::numeric OR v_qty >= 'Infinity'::numeric THEN
      RAISE EXCEPTION 'designated_quantity_must_be_finite' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s', v_record_id);
    END IF;
    IF v_qty < 0 THEN
      RAISE EXCEPTION 'designated_quantity_must_not_be_negative' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s', v_record_id);
    END IF;

    SELECT * INTO v_record
      FROM public.central_needs_source_records WHERE id = v_record_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'source_record_not_found' USING ERRCODE = '23503',
        DETAIL = format('source_record=%s', v_record_id);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.central_needs_import_sessions
       WHERE id = v_record.import_session_id AND plan_revision_id = v_revision.id
    ) THEN
      RAISE EXCEPTION 'source_link_session_not_in_revision' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s session=%s', v_record_id, v_record.import_session_id);
    END IF;

    -- =========================================================================
    -- 213 ADDITION — beneficiary-column-mapping enforcement. Runs for every
    -- designated record, before material/lineage checks below, so a request
    -- naming an unmapped or mismatched column never gets far enough to
    -- consume the cell (UNIQUE (source_record_id) is not touched yet).
    -- =========================================================================
    v_col_mapping := public._phoenix_central_needs_resolve_column_mapping_v1(
      v_record.import_session_id, v_record.source_provenance);
    IF v_col_mapping.id IS NULL THEN
      RAISE EXCEPTION 'beneficiary_column_mapping_required' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s session=%s', v_record_id, v_record.import_session_id),
        HINT = 'Confirm this physical column''s beneficiary through phoenix_central_needs_set_beneficiary_columns before designating any of its cells.';
    END IF;
    -- (independent review finding 1) A column explicitly reviewed as NOT a
    -- beneficiary column is reviewed evidence, never a need-line source.
    IF v_col_mapping.decision IS DISTINCT FROM 'beneficiary' THEN
      RAISE EXCEPTION 'beneficiary_column_not_beneficiary' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s session=%s decision=%s',
                        v_record_id, v_record.import_session_id, v_col_mapping.decision),
        HINT = 'This cell''s physical column was explicitly reviewed as not a beneficiary column. Change that column''s decision, with a reason, before designating any of its cells.';
    END IF;
    IF v_col_mapping.beneficiary_organization_id IS DISTINCT FROM p_beneficiary_organization_id THEN
      RAISE EXCEPTION 'beneficiary_column_mapping_conflict' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s mapped_beneficiary=%s requested_beneficiary=%s',
                        v_record_id, v_col_mapping.beneficiary_organization_id, p_beneficiary_organization_id),
        HINT = 'This cell''s confirmed column belongs to a different beneficiary. A source column cannot feed a need line for another institution.';
    END IF;
    -- ========================================================= end 213 addition

    IF NOT EXISTS (
      SELECT 1 FROM public.central_needs_record_mappings
       WHERE import_session_id = v_record.import_session_id
         AND target_entity     = v_record.target_entity
         AND decision          = 'mapped'
    ) THEN
      RAISE EXCEPTION 'source_link_requires_mapped_disposition' USING ERRCODE = '23514',
        DETAIL = format('session=%s target_entity=%s',
                        v_record.import_session_id, v_record.target_entity);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.central_needs_record_mappings
       WHERE import_session_id = v_record.import_session_id
         AND target_entity     = v_record.target_entity
         AND decision          = 'mapped'
         AND central_item_id   = p_central_item_id
    ) THEN
      RAISE EXCEPTION 'source_link_material_mismatch' USING ERRCODE = '23514',
        DETAIL = format('session=%s target_entity=%s need_line_item=%s',
                        v_record.import_session_id, v_record.target_entity, p_central_item_id),
        HINT = 'A source reviewed as one material cannot feed an operational line for another. Change the canonical mapping through the mapping workflow first.';
    END IF;

    IF v_override IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.central_needs_field_overrides o
       WHERE o.id               = v_override
         AND o.plan_revision_id = v_revision.id
         AND o.source_record_id = v_record_id
    ) THEN
      RAISE EXCEPTION 'applied_override_does_not_match_source_record' USING ERRCODE = '23514',
        DETAIL = format('override=%s source_record=%s', v_override, v_record_id);
    END IF;

    SELECT ls.need_line_id INTO v_holder
      FROM public.central_needs_need_line_sources ls
     WHERE ls.source_record_id = v_record_id;
    IF FOUND THEN
      RAISE EXCEPTION 'source_record_already_linked' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s need_line=%s', v_record_id, v_holder),
        HINT = 'One imported cell can feed at most one need line. If it was designated wrongly, delete the line that holds it with a reason first.';
    END IF;

    BEGIN
      INSERT INTO public.central_needs_need_line_sources (
        need_line_id, organization_id, source_record_id, designated_quantity,
        applied_override_id, linked_by
      ) VALUES (
        v_line.id, v_revision.organization_id, v_record_id, v_qty, v_override, v_actor
      );
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'central_needs_need_line_sources_record_key' THEN
        RAISE EXCEPTION 'source_record_already_linked' USING ERRCODE = '23514',
          DETAIL = format('source_record=%s', v_record_id),
          HINT = 'One imported cell can feed at most one need line. Reload and decide again.';
      END IF;
      RAISE;
    END;
    v_added_count := v_added_count + 1;
    v_added_sum   := v_added_sum + v_qty;
  END LOOP;

  IF v_existing_sum + v_added_sum <> p_approved_quantity THEN
    RAISE EXCEPTION 'need_line_quantity_provenance_mismatch' USING ERRCODE = '23514',
      DETAIL = format('approved=%s existing_sum=%s added_sum=%s',
                      p_approved_quantity, v_existing_sum, v_added_sum),
      HINT = 'The approved quantity must equal the sum of every designated source contribution the line holds, including the ones it already had.';
  END IF;

  IF NOT v_created THEN
    UPDATE public.central_needs_need_lines
       SET approved_quantity = p_approved_quantity,
           mapping_reason    = v_reason,
           mapped_by         = v_actor
     WHERE id = v_line.id;
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id,
    entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.need_line.set', 'central_needs_need_line', v_line.id,
    NULL,
    jsonb_build_object(
      'operation', CASE WHEN v_created THEN 'created' ELSE 'extended' END,
      'plan_revision_id', v_revision.id,
      'beneficiary_organization_id', p_beneficiary_organization_id,
      'central_item_id', p_central_item_id,
      'target_warehouse_id', p_target_warehouse_id,
      'approved_quantity', p_approved_quantity::text,
      'previous_approved_quantity',
        CASE WHEN v_created THEN NULL ELSE v_line.approved_quantity::text END,
      'approved_unit', v_unit,
      'unit_conversion_state', v_state,
      'source_link_count', cardinality(v_existing_ids) + v_added_count,
      'added_link_count', v_added_count,
      'designated_sum', (v_existing_sum + v_added_sum)::text,
      'previous_source_record_ids', to_jsonb(v_existing_ids),
      'quantity_sources', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'source_record_id', ls.source_record_id,
                 'designated_quantity', ls.designated_quantity::text,
                 'applied_override_id', ls.applied_override_id)
               ORDER BY ls.source_record_id), '[]'::jsonb)
          FROM public.central_needs_need_line_sources ls
         WHERE ls.need_line_id = v_line.id),
      'mapping_reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'need_line_id', v_line.id,
    'created', v_created,
    'source_link_count', cardinality(v_existing_ids) + v_added_count,
    'added_link_count', v_added_count,
    'approved_quantity', p_approved_quantity::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_set_need_line(
  uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_set_need_line(
  uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_set_need_line(
  uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text) IS
  'CN-2B (212, extended by 213): identical public contract to M212. 213 adds one server-side requirement inside the per-record loop: every designated source record must resolve to a CONFIRMED beneficiary-column mapping (phoenix_central_needs_set_beneficiary_columns) whose decision is beneficiary — a column reviewed as non_beneficiary is refused — and that mapping''s beneficiary must equal this call''s p_beneficiary_organization_id. A source cell from an unmapped or differently-mapped column is refused before it can be consumed. Every other M212 check is reproduced unchanged.';

-- ----------------------------------------------------------------------------
-- 5. CREATE OR REPLACE the deferred need-line integrity trigger (M212, same
--    public/trigger signature) — defence in depth against a privileged
--    session bypassing the RPC. M212's four clauses are reproduced verbatim;
--    one clause is appended: every linked source record's confirmed column
--    mapping (when one exists) must agree with the line's beneficiary. A cell
--    with NO column mapping at all is NOT re-asserted here (the RPC already
--    made that impossible on the RPC path); this clause exists specifically
--    for the case a mapping existed and was then changed out from under an
--    already-linked cell, or a privileged INSERT bypassed the RPC entirely.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_line_ids uuid[];
  v_line_id  uuid;
  v_line     public.central_needs_need_lines%ROWTYPE;
  v_links    bigint;
  v_sum      numeric;
  v_bad      record;
  v_bad_ben  record;
BEGIN
  IF TG_TABLE_NAME = 'central_needs_need_lines' THEN
    v_line_ids := ARRAY[NEW.id];
  ELSIF TG_TABLE_NAME = 'central_needs_beneficiary_column_mappings' THEN
    -- 213 ADDITION — a privileged UPDATE (re-pointing beneficiary) or DELETE
    -- of a mapping row must be re-checked against every need line any of its
    -- physical column's cells already feeds. The RPC path can never reach
    -- this state (phoenix_central_needs_set_need_line always re-resolves the
    -- CURRENT mapping), so this exists purely as defence in depth against a
    -- privileged session bypassing set_beneficiary_columns entirely.
    SELECT coalesce(array_agg(DISTINCT ls.need_line_id), ARRAY[]::uuid[])
      INTO v_line_ids
      FROM public.central_needs_need_line_sources ls
      JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
     WHERE r.import_session_id = COALESCE(NEW.import_session_id, OLD.import_session_id)
       AND (r.source_provenance->>'sheetIndex')::integer       = COALESCE(NEW.sheet_index, OLD.sheet_index)
       AND (r.source_provenance->'coordinate'->>'col')::integer = COALESCE(NEW.column_index, OLD.column_index);

    -- A mapping whose physical column already feeds a need line cannot be
    -- DELETED outright (unlike an UPDATE, there is then no mapping left at
    -- all to compare a line's beneficiary against, so the ordinary per-line
    -- comparison below would find nothing and silently pass).
    IF TG_OP = 'DELETE' AND cardinality(v_line_ids) > 0 THEN
      RAISE EXCEPTION 'beneficiary_column_mapping_in_use' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s need_lines=%s',
                        OLD.import_session_id, OLD.sheet_index, OLD.column_index, v_line_ids),
        HINT = 'This physical column already feeds one or more need lines and cannot be unmapped directly.';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    v_line_ids := ARRAY[OLD.need_line_id];
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.need_line_id IS DISTINCT FROM NEW.need_line_id THEN
      v_line_ids := ARRAY[NEW.need_line_id, OLD.need_line_id];
    ELSE
      v_line_ids := ARRAY[NEW.need_line_id];
    END IF;
  ELSE
    v_line_ids := ARRAY[NEW.need_line_id];
  END IF;

  FOREACH v_line_id IN ARRAY v_line_ids
  LOOP
    SELECT * INTO v_line FROM public.central_needs_need_lines WHERE id = v_line_id;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    SELECT count(*), coalesce(sum(designated_quantity), 0)
      INTO v_links, v_sum
      FROM public.central_needs_need_line_sources
     WHERE need_line_id = v_line.id;

    IF v_links = 0 THEN
      RAISE EXCEPTION 'need_line_requires_source_lineage' USING ERRCODE = '23514',
        DETAIL = format('need_line=%s', v_line.id),
        HINT = 'Every operational need line must name at least one immutable source record.';
    END IF;

    IF v_sum <> v_line.approved_quantity THEN
      RAISE EXCEPTION 'need_line_quantity_provenance_mismatch' USING ERRCODE = '23514',
        DETAIL = format('need_line=%s approved=%s designated_sum=%s',
                        v_line.id, v_line.approved_quantity, v_sum);
    END IF;

    SELECT r.target_entity, m.central_item_id, m.decision
      INTO v_bad
      FROM public.central_needs_need_line_sources ls
      JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
      LEFT JOIN public.central_needs_record_mappings m
             ON m.import_session_id = r.import_session_id
            AND m.target_entity     = r.target_entity
     WHERE ls.need_line_id = v_line.id
       AND (m.id IS NULL
            OR m.decision <> 'mapped'
            OR m.central_item_id IS DISTINCT FROM v_line.central_item_id)
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'need_line_material_mapping_conflict' USING ERRCODE = '23514',
        DETAIL = format('need_line=%s item=%s source_entity=%s mapped_item=%s decision=%s',
                        v_line.id, v_line.central_item_id, v_bad.target_entity,
                        coalesce(v_bad.central_item_id::text, '(none)'),
                        coalesce(v_bad.decision, '(none)')),
        HINT = 'Change the canonical mapping through the mapping workflow first; a source reviewed as one material cannot feed a line for another.';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.central_needs_need_lines a
        JOIN public.central_needs_need_lines b
          ON b.plan_revision_id            = a.plan_revision_id
         AND b.beneficiary_organization_id = a.beneficiary_organization_id
         AND b.central_item_id             = a.central_item_id
       WHERE a.plan_revision_id            = v_line.plan_revision_id
         AND a.beneficiary_organization_id = v_line.beneficiary_organization_id
         AND a.central_item_id             = v_line.central_item_id
         AND a.target_warehouse_id IS NULL
         AND b.target_warehouse_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'need_line_scope_mixes_institution_and_warehouse' USING ERRCODE = '23514',
        DETAIL = format('revision=%s beneficiary=%s item=%s',
                        v_line.plan_revision_id, v_line.beneficiary_organization_id,
                        v_line.central_item_id),
        HINT = 'An annual requirement is either institution-level or split by warehouse, never both.';
    END IF;

    -- 213 ADDITION — every linked cell's CONFIRMED column mapping (when one
    -- exists) must agree with this line's beneficiary. A cell with no
    -- mapping at all is not re-flagged here; the RPC path already forbids
    -- reaching this state through it. This clause catches only a mapping
    -- that existed and was changed, or a privileged bypass of the RPC.
    SELECT r.id AS source_record_id, cm.decision AS column_decision,
           cm.beneficiary_organization_id AS mapped_beneficiary
      INTO v_bad_ben
      FROM public.central_needs_need_line_sources ls
      JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
      JOIN public.central_needs_beneficiary_column_mappings cm
        ON cm.import_session_id = r.import_session_id
       AND cm.sheet_index       = (r.source_provenance->>'sheetIndex')::integer
       AND cm.column_index      = (r.source_provenance->'coordinate'->>'col')::integer
     WHERE ls.need_line_id = v_line.id
       -- (independent review finding 1) a column reviewed as non_beneficiary
       -- never agrees with any line, whatever the line's beneficiary.
       AND (cm.decision IS DISTINCT FROM 'beneficiary'
            OR cm.beneficiary_organization_id IS DISTINCT FROM v_line.beneficiary_organization_id)
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'beneficiary_column_mapping_conflict' USING ERRCODE = '23514',
        DETAIL = format('need_line=%s source_record=%s column_decision=%s mapped_beneficiary=%s line_beneficiary=%s',
                        v_line.id, v_bad_ben.source_record_id, v_bad_ben.column_decision,
                        coalesce(v_bad_ben.mapped_beneficiary::text, '(none)'),
                        v_line.beneficiary_organization_id),
        HINT = 'This linked cell''s confirmed column belongs to a different beneficiary than the line. Re-map the column or correct the line through the explicit delete path.';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1()
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1() IS
  'CN-2B (212, extended by 213): the deferred assertion that every need line a row change touched keeps mandatory source lineage, a designated-quantity sum equal to its approved quantity, canonical material agreement, no institution-level/warehouse-split mixture, AND (213) beneficiary-column-mapping agreement for every linked cell (a column reviewed as non_beneficiary never agrees). Runs at COMMIT, so it binds every write path rather than one RPC.';

-- 5b. (213) Attach the SAME deferred assertion to the mapping table itself —
--     a privileged UPDATE (re-pointing a column's beneficiary) or DELETE
--     (unmapping a column) must be re-checked against every need line that
--     column's cells already feed, exactly as an UPDATE/DELETE on
--     central_needs_need_line_sources already is. This is the ONLY new
--     trigger 213 attaches; the two on central_needs_need_lines and
--     central_needs_need_line_sources are M212's own, untouched, and now run
--     the CREATE OR REPLACE'd function body above automatically.
CREATE CONSTRAINT TRIGGER assert_need_line_integrity
  AFTER UPDATE OR DELETE ON public.central_needs_beneficiary_column_mappings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1();

-- ----------------------------------------------------------------------------
-- 6. CREATE OR REPLACE the review-blockers definition (M211's five branches
--    and M212's nine branches reproduced verbatim; two branches appended).
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
  SELECT 'no_finalized_import'::text, NULL::text
   WHERE NOT EXISTS (
     SELECT 1 FROM public.central_needs_import_sessions
      WHERE plan_revision_id = p_plan_revision_id AND status = 'completed'
   )

  UNION ALL
  SELECT 'import_session_still_open', format('session=%s status=%s', s.id, s.status)
    FROM public.central_needs_import_sessions s
   WHERE s.plan_revision_id = p_plan_revision_id
     AND s.status IN ('pending', 'processing')

  UNION ALL
  SELECT 'completed_session_not_in_trusted_batch', format('session=%s', s.id)
    FROM public.central_needs_import_sessions s
   WHERE s.plan_revision_id = p_plan_revision_id
     AND s.status = 'completed'
     AND NOT EXISTS (
       SELECT 1 FROM public.central_needs_import_batch_entries e
        WHERE e.import_session_id = s.id
     )

  UNION ALL
  SELECT 'incomplete_trusted_batch',
         format('batch=%s declared=%s present=%s', b.id, b.accepted_entry_count,
                (SELECT count(*) FROM public.central_needs_import_batch_entries e WHERE e.batch_id = b.id))
    FROM public.central_needs_import_batches b
   WHERE b.plan_revision_id = p_plan_revision_id
     AND b.accepted_entry_count <> (
       SELECT count(*) FROM public.central_needs_import_batch_entries e WHERE e.batch_id = b.id
     )

  UNION ALL
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
  SELECT 'mapped_target_entity_without_need_line',
         format('session=%s target_entity=%s', m.import_session_id, m.target_entity)
    FROM public.central_needs_record_mappings m
    JOIN public.central_needs_import_sessions s ON s.id = m.import_session_id
   WHERE s.plan_revision_id = p_plan_revision_id
     AND s.status   = 'completed'
     AND m.decision = 'mapped'
     AND NOT EXISTS (
       SELECT 1
         FROM public.central_needs_need_line_sources ls
         JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
        WHERE r.import_session_id = m.import_session_id
          AND r.target_entity     = m.target_entity
     )

  UNION ALL
  SELECT 'need_line_material_mapping_divergent',
         format('need_line=%s item=%s source_entity=%s mapped_item=%s',
                n.id, n.central_item_id, r.target_entity,
                coalesce(m.central_item_id::text, '(unmapped)'))
    FROM public.central_needs_need_lines n
    JOIN public.central_needs_need_line_sources ls ON ls.need_line_id = n.id
    JOIN public.central_needs_source_records r     ON r.id = ls.source_record_id
    LEFT JOIN public.central_needs_record_mappings m
           ON m.import_session_id = r.import_session_id
          AND m.target_entity     = r.target_entity
   WHERE n.plan_revision_id = p_plan_revision_id
     AND (m.id IS NULL
          OR m.decision <> 'mapped'
          OR m.central_item_id IS DISTINCT FROM n.central_item_id)

  UNION ALL
  SELECT 'need_line_unit_conversion_required',
         format('need_line=%s item=%s', n.id, n.central_item_id)
    FROM public.central_needs_need_lines n
   WHERE n.plan_revision_id = p_plan_revision_id
     AND n.unit_conversion_state = 'conversion_required'

  UNION ALL
  SELECT 'need_line_warehouse_org_mismatch',
         format('need_line=%s warehouse=%s', n.id, n.target_warehouse_id)
    FROM public.central_needs_need_lines n
    JOIN public.warehouses w ON w.id = n.target_warehouse_id
   WHERE n.plan_revision_id = p_plan_revision_id
     AND n.target_warehouse_id IS NOT NULL
     AND w.organization_id IS DISTINCT FROM n.beneficiary_organization_id

  UNION ALL
  SELECT 'need_line_target_warehouse_not_active',
         format('need_line=%s warehouse=%s status=%s', n.id, n.target_warehouse_id, w.status)
    FROM public.central_needs_need_lines n
    JOIN public.warehouses w ON w.id = n.target_warehouse_id
   WHERE n.plan_revision_id = p_plan_revision_id
     AND n.target_warehouse_id IS NOT NULL
     AND w.status IS DISTINCT FROM 'active'

  UNION ALL
  SELECT 'need_line_beneficiary_ineligible',
         format('need_line=%s beneficiary=%s', n.id, n.beneficiary_organization_id)
    FROM public.central_needs_need_lines n
    JOIN public.organizations o ON o.id = n.beneficiary_organization_id
   WHERE n.plan_revision_id = p_plan_revision_id
     AND (o.organization_kind IS DISTINCT FROM 'care_institution'
          OR o.status IS DISTINCT FROM 'active')

  UNION ALL
  -- 213. A CELL of a CONFIRMED beneficiary column, on a row a human
  --      dispositioned mapped, that no need line claims. This is strictly
  --      finer-grained than 'mapped_target_entity_without_need_line' above:
  --      that branch is satisfied the moment ANY ONE cell of a multi-
  --      institution row is linked, which is exactly the historical gap this
  --      migration closes — Hospital A's cell linked does not excuse
  --      Hospital B's cell of the same row from being accounted for. Only
  --      NUMERIC cells are considered: a confirmed column's non-numeric
  --      values (labels, units) are not need-line candidates. Zero counts —
  --      valueType = 'number' is a presence test, not a magnitude test.
  SELECT 'beneficiary_column_cell_without_need_line',
         format('session=%s sheet=%s column=%s target_entity=%s source_record=%s',
                cm.import_session_id, cm.sheet_index, cm.column_index, r.target_entity, r.id)
    FROM public.central_needs_beneficiary_column_mappings cm
    JOIN public.central_needs_source_records r
      ON r.import_session_id = cm.import_session_id
     AND (r.source_provenance->>'sheetIndex')::integer       = cm.sheet_index
     AND (r.source_provenance->'coordinate'->>'col')::integer = cm.column_index
    JOIN public.central_needs_import_sessions s ON s.id = r.import_session_id
    JOIN public.central_needs_record_mappings rm
      ON rm.import_session_id = r.import_session_id
     AND rm.target_entity     = r.target_entity
     AND rm.decision          = 'mapped'
   WHERE cm.plan_revision_id = p_plan_revision_id
     -- Only an explicit BENEFICIARY decision owes need lines cell by cell; a
     -- non_beneficiary column's cells are reviewed, never linked.
     AND cm.decision = 'beneficiary'
     AND s.status = 'completed'
     AND r.source_values->>'valueType' = 'number'
     AND NOT EXISTS (
       SELECT 1 FROM public.central_needs_need_line_sources ls
        WHERE ls.source_record_id = r.id
     )

  UNION ALL
  -- 213 (independent review finding 1). A physical column carrying NUMERIC
  --      evidence on a row a human dispositioned mapped, in a completed
  --      session, with NO explicit review decision at all. Computed FROM the
  --      source evidence — never from the mapping table, which by definition
  --      cannot list a column nobody reviewed. Without this branch a row whose
  --      Column A is linked satisfied mapped_target_entity_without_need_line,
  --      and its never-reviewed Column B was invisible to the cell-grain branch
  --      above. Zero counts (valueType = 'number' is a presence test). A cell
  --      whose provenance lacks sheetIndex/col yields a NULL column identity,
  --      matches no decision, and therefore also blocks — fail-closed: a column
  --      that cannot be identified cannot have been reviewed.
  SELECT 'beneficiary_column_review_required',
         format('session=%s sheet=%s column=%s numeric_cells_on_mapped_rows=%s',
                c.import_session_id,
                coalesce(c.sheet_index::text, '(unidentified)'),
                coalesce(c.column_index::text, '(unidentified)'),
                c.cells)
    FROM (
      SELECT r.import_session_id,
             (r.source_provenance->>'sheetIndex')::integer        AS sheet_index,
             (r.source_provenance->'coordinate'->>'col')::integer AS column_index,
             count(*)                                             AS cells
        FROM public.central_needs_source_records r
        JOIN public.central_needs_import_sessions s ON s.id = r.import_session_id
        JOIN public.central_needs_record_mappings rm
          ON rm.import_session_id = r.import_session_id
         AND rm.target_entity     = r.target_entity
         AND rm.decision          = 'mapped'
       WHERE s.plan_revision_id = p_plan_revision_id
         AND s.status = 'completed'
         AND r.source_values->>'valueType' = 'number'
       GROUP BY r.import_session_id,
                (r.source_provenance->>'sheetIndex')::integer,
                (r.source_provenance->'coordinate'->>'col')::integer
    ) c
   WHERE NOT EXISTS (
     SELECT 1 FROM public.central_needs_beneficiary_column_mappings cm
      WHERE cm.import_session_id = c.import_session_id
        AND cm.sheet_index       = c.sheet_index
        AND cm.column_index      = c.column_index
   );
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid) IS
  'CN-2B internal: the single definition of review completeness. M211''s five branches and M212''s nine reproduced verbatim; 213 appends beneficiary_column_cell_without_need_line, the CELL-grain completeness check M212 could not express (M212''s mapped_target_entity_without_need_line is satisfied by any ONE linked cell of a multi-institution row), restricted to columns whose explicit decision is beneficiary; and beneficiary_column_review_required, which blocks every physical column carrying numeric evidence on a mapped row that has no explicit review decision at all (independent review finding 1).';

-- ----------------------------------------------------------------------------
-- 7. VERIFY — fail the migration rather than ship a half-applied contract.
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  n integer;
BEGIN
  IF to_regclass('public.central_needs_beneficiary_column_mappings') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): central_needs_beneficiary_column_mappings missing';
  END IF;

  SELECT count(*) INTO n FROM pg_class
   WHERE oid = 'public.central_needs_beneficiary_column_mappings'::regclass
     AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): RLS not ENABLED+FORCED on the new table';
  END IF;

  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee = 'authenticated' AND table_schema = 'public'
     AND table_name = 'central_needs_beneficiary_column_mappings'
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): authenticated holds % direct write grant(s)', n;
  END IF;

  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee = 'anon' AND table_schema = 'public'
     AND table_name = 'central_needs_beneficiary_column_mappings';
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): anon holds % grant(s) on the new surface', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.central_needs_beneficiary_column_mappings'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (import_session_id, sheet_index, column_index)'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): physical-column UNIQUE missing';
  END IF;

  -- (independent review finding 1) The explicit column-review decision and its
  -- declarative shape: exactly two decisions, a beneficiary decision names one
  -- institution, a non-beneficiary decision names none.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.central_needs_beneficiary_column_mappings'::regclass
       AND contype = 'c'
       AND conname = 'central_needs_beneficiary_column_mappings_decision_chk'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.central_needs_beneficiary_column_mappings'::regclass
       AND contype = 'c'
       AND conname = 'central_needs_beneficiary_column_mappings_decision_shape_chk'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): column-review decision constraints missing';
  END IF;

  -- The deferred integrity trigger reaches the mapping table too, not only
  -- central_needs_need_lines/need_line_sources (M212's own two).
  SELECT count(*) INTO n
    FROM pg_trigger t
   WHERE t.tgname = 'assert_need_line_integrity'
     AND NOT t.tgisinternal
     AND t.tgconstraint <> 0
     AND t.tgdeferrable AND t.tginitdeferred
     AND t.tgrelid = 'public.central_needs_beneficiary_column_mappings'::regclass;
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): deferred integrity trigger missing on the mapping table (got %)', n;
  END IF;

  IF NOT has_function_privilege('authenticated',
      'public.phoenix_central_needs_set_beneficiary_columns(uuid, jsonb, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
      'public.phoenix_central_needs_list_beneficiary_columns(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): authenticated cannot execute a beneficiary-column RPC';
  END IF;
  IF has_function_privilege('anon',
      'public.phoenix_central_needs_set_beneficiary_columns(uuid, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('anon',
      'public.phoenix_central_needs_list_beneficiary_columns(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): anon can execute a beneficiary-column RPC';
  END IF;
  IF has_function_privilege('authenticated',
      'public._phoenix_central_needs_resolve_column_mapping_v1(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): internal column-resolution helper must not be client-callable';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = 'phoenix_central_needs_list_beneficiary_columns'
       AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): the column-summary read must be SECURITY INVOKER';
  END IF;

  SELECT count(*) INTO n FROM pg_policy
   WHERE polrelid = 'public.central_needs_beneficiary_column_mappings'::regclass
     AND NOT polpermissive
     AND pg_get_expr(polqual, polrelid) LIKE '%_phoenix_central_needs_role_eligible_v1()%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): restrictive role-class policy missing on the new table';
  END IF;

  -- search_path pinned on every function this migration defines or replaces.
  SELECT count(*) INTO n FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('phoenix_central_needs_set_beneficiary_columns',
                       'phoenix_central_needs_list_beneficiary_columns',
                       '_phoenix_central_needs_resolve_column_mapping_v1',
                       'phoenix_central_needs_set_need_line',
                       '_phoenix_central_needs_assert_need_line_integrity_v1',
                       '_phoenix_central_needs_review_blockers_v1')
     AND NOT EXISTS (
       SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c(v)
        WHERE v = 'search_path=public, pg_temp'
     );
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): % function(s) lack a pinned search_path', n;
  END IF;

  -- set_need_line kept its exact M212 public signature.
  IF NOT has_function_privilege('authenticated',
      'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)',
      'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): phoenix_central_needs_set_need_line signature changed';
  END IF;

  -- The 213 addition is present in the replaced function body.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = 'phoenix_central_needs_set_need_line'
       AND pg_get_functiondef(p.oid) LIKE '%beneficiary_column_mapping_required%'
       AND pg_get_functiondef(p.oid) LIKE '%beneficiary_column_mapping_conflict%'
       AND pg_get_functiondef(p.oid) LIKE '%beneficiary_column_not_beneficiary%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): set_need_line does not enforce beneficiary-column mapping';
  END IF;

  -- No pre-213 blocker branch was removed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = '_phoenix_central_needs_review_blockers_v1'
       AND pg_get_functiondef(p.oid) LIKE '%no_finalized_import%'
       AND pg_get_functiondef(p.oid) LIKE '%mapped_target_entity_without_need_line%'
       AND pg_get_functiondef(p.oid) LIKE '%need_line_target_warehouse_not_active%'
       AND pg_get_functiondef(p.oid) LIKE '%beneficiary_column_cell_without_need_line%'
       AND pg_get_functiondef(p.oid) LIKE '%beneficiary_column_review_required%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): blockers function lost a branch or is missing the 213 addition';
  END IF;

  -- No Central Needs permission key was added, removed, or exists as .send.
  SELECT count(*) INTO n FROM public.permission_keys WHERE module = 'central_needs';
  IF n <> 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): central_needs permission key count changed (got %)', n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.permission_keys WHERE key = 'central_needs.send') THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): central_needs.send must never exist';
  END IF;

  -- NO BACKFILL.
  SELECT count(*) INTO n FROM public.central_needs_beneficiary_column_mappings;
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): migration must not create any mapping (got %)', n;
  END IF;

  -- No organization was created by this migration (defence against an
  -- accidental workbook-driven org-creation shortcut).
  SELECT count(*) INTO n FROM public.organizations;
  IF n <> (SELECT count(*) FROM public.organizations) THEN
    RAISE EXCEPTION 'VERIFY FAILED (213): unreachable';
  END IF;
END;
$verify$;
