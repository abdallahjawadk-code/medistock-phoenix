-- ===========================================================================
-- C4 / M216 — CENTRAL NEEDS BENEFICIARY-REGION PERSISTENCE
--
-- WHY THIS MIGRATION EXISTS
--   M213 persists a beneficiary decision at WHOLE-COLUMN grain: one physical
--   column (import_session_id, sheet_index, column_index) -> one decision. The
--   Excel-first surface (E2-C) lets a human declare a Need source as a general
--   RECTANGLE, and the real corpus stacks several institutions in one column.
--   Director ruling C-1 REJECTED reducing those rectangles to M213's grain, so
--   rectangles must persist as authoritative, revision-owned server truth.
--
--   This migration implements the frozen C4 Region-Persistence Contract
--   (D:/phoenix-evidence/C4-Region-Persistence-Contract-Freeze, documents
--   00-13, with Director amendments B1 and B2) and nothing else.
--
-- WHAT THIS MIGRATION ADDS
--   1. ONE relation, central_needs_beneficiary_regions: immutable decision
--      VERSIONS of logical regions (B1). region_id = lineage identity;
--      version_id = version identity. A version is ACTIVE while its retirement
--      stamp is empty. Content never changes; the only mutation is ONE complete
--      retirement stamp, plus the house FK ON DELETE SET NULL of the actor
--      columns. Rows are never deleted.
--   2. Internal helpers (never client-callable): the safe coordinate
--      extractor, an M213-equivalent non-raising cast, the ACTIVE-version
--      resolver, the linked-cell rule, and the T5' column-coverage predicate.
--   3. T1 (BEFORE, row): draft-only insert, born ACTIVE, the one-time complete
--      stamp and the FK actor nulling as the ONLY updates, no delete. Reads the
--      owning revision's status under a FOR SHARE row lock.
--   4. T2 (deferred): the need-line integrity function on the new relation.
--   5. T3 (deferred): overlap, X1 and lineage over ACTIVE versions.
--   6. T4 (deferred): X1 on the EXISTING M213 table — the first
--      cross-migration trigger in Central Needs (Director acknowledgement at
--      migration review).
--   7. ONE public write RPC, phoenix_central_needs_set_beneficiary_regions:
--      add | replace | remove | convert_column over ONE (session, sheet).
--   8. Behaviour-only replacements, identical signatures and shapes:
--        phoenix_central_needs_set_need_line        (per-cell beneficiary grain)
--        _phoenix_central_needs_assert_need_line_integrity_v1 (region branch,
--                                                    per-line region clause, T5')
--        _phoenix_central_needs_review_blockers_v1  (branches 1-12 verbatim,
--                                                    13 per-cell exclusion,
--                                                    14-18 appended)
--        phoenix_central_needs_list_beneficiary_columns (review_required
--                                                    narrowed exactly as 13)
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * no edit of any M209-M215 file; no change to the M213 table's columns,
--     constraints, indexes, policies, vocabulary or existing triggers; no
--     change to the M213 resolver or the set_beneficiary_columns body;
--   * no change to submit, review_readiness (stays VOLATILE) or any M215
--     lifecycle function; no clone, carry-forward or adoption of regions;
--   * no quantity, unit, material, warehouse or need-line field on a region;
--     M212's set_need_line stays the only need-line writer;
--   * no audit schema or policy change and no audit read path;
--   * no stock, movement, allocation or transfer object;
--   * NO BACKFILL. A region exists only where a human declared it.
--
-- COORDINATE FRAME
--   Parser-physical, 0-based, inclusive: rows 0..1,048,575, columns
--   0..16,383. A whole column is [0..1,048,575] x [c..c], stored as explicit
--   integers. A coordinate is "safely extracted" only when it is a JSON number
--   written as plain decimal digits within that ceiling; anything else is
--   unidentified and never lies inside a region.
-- ===========================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Preconditions. Fail closed rather than half-apply.
-- ----------------------------------------------------------------------------
DO $precondition$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'central_needs_plans', 'central_needs_plan_revisions', 'central_needs_import_sessions',
    'central_needs_source_records', 'central_needs_record_mappings',
    'central_needs_need_lines', 'central_needs_need_line_sources',
    'central_needs_beneficiary_column_mappings', 'audit_logs'
  ] LOOP
    IF to_regclass('public.' || f) IS NULL THEN
      RAISE EXCEPTION '216_precondition_failed: table % is absent', f;
    END IF;
  END LOOP;

  IF to_regclass('public.central_needs_beneficiary_regions') IS NOT NULL THEN
    RAISE EXCEPTION '216_precondition_failed: central_needs_beneficiary_regions already exists';
  END IF;

  -- M211's session key and M209's revision key, the targets of the two
  -- composite FKs below.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.central_needs_import_sessions'::regclass
       AND contype  = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (id, plan_revision_id, organization_id)'
  ) THEN
    RAISE EXCEPTION '216_precondition_failed: central_needs_import_sessions UNIQUE (id, plan_revision_id, organization_id) absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.central_needs_plan_revisions'::regclass
       AND contype  = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (id, organization_id)'
  ) THEN
    RAISE EXCEPTION '216_precondition_failed: central_needs_plan_revisions UNIQUE (id, organization_id) absent';
  END IF;

  -- M210/M211/M212/M213 surface this migration reuses or replaces, and M215's
  -- reason helper, lock helper and lifecycle functions (applied in Production
  -- as 20260922153813; this block is a guard for every target database).
  FOREACH f IN ARRAY ARRAY[
    'public._phoenix_central_needs_role_eligible_v1()',
    'public._phoenix_central_needs_guard_v1(uuid, text)',
    'public._phoenix_central_needs_load_revision_v1(uuid)',
    'public._phoenix_central_needs_assert_org_live_v1(uuid)',
    'public._phoenix_central_needs_assert_draft_v1(uuid, text)',
    'public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid)',
    'public._phoenix_central_needs_resolve_column_mapping_v1(uuid, jsonb)',
    'public._phoenix_central_needs_assert_need_line_integrity_v1()',
    'public._phoenix_central_needs_review_blockers_v1(uuid)',
    'public.phoenix_central_needs_set_beneficiary_columns(uuid, jsonb, text)',
    'public.phoenix_central_needs_list_beneficiary_columns(uuid)',
    'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)',
    'public.phoenix_central_needs_delete_need_line(uuid, text, uuid[])',
    'public.phoenix_central_needs_submit_revision(uuid)',
    'public.phoenix_central_needs_review_readiness(uuid)',
    'public._phoenix_central_needs_human_text_v1(text)',
    'public._phoenix_central_needs_lock_plan_family_v1(uuid, integer)',
    'public.phoenix_central_needs_open_correction_revision(uuid, integer, uuid, text)',
    'public.phoenix_central_needs_approve_revision(uuid)',
    'public.phoenix_central_needs_reject_revision(uuid, text)',
    'public.phoenix_central_needs_revision_lifecycle(uuid, integer)',
    'public.phoenix_status_center_authorized(uuid, text)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION '216_precondition_failed: % is absent', f;
    END IF;
  END LOOP;

  -- The M213 table carries exactly its own two triggers before T4 is added.
  IF (SELECT array_agg(tgname::text ORDER BY tgname) FROM pg_trigger
       WHERE tgrelid = 'public.central_needs_beneficiary_column_mappings'::regclass
         AND NOT tgisinternal)
     IS DISTINCT FROM ARRAY['assert_need_line_integrity', 'set_updated_at'] THEN
    RAISE EXCEPTION '216_precondition_failed: the M213 table does not carry exactly its reviewed triggers';
  END IF;

  -- Fingerprint the M213 table surface (columns, constraints, indexes,
  -- policies) so VERIFY can prove this migration left it unchanged.
  PERFORM set_config('phoenix_m216.m213_surface', (
    SELECT md5(string_agg(x, E'\n' ORDER BY x)) FROM (
      SELECT 'col ' || attname || ' ' || format_type(atttypid, atttypmod) || ' ' || attnotnull::text
             || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = 'public.central_needs_beneficiary_column_mappings'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'con ' || conname || ' ' || pg_get_constraintdef(oid)
        FROM pg_constraint WHERE conrelid = 'public.central_needs_beneficiary_column_mappings'::regclass AND contype <> 't'
      UNION ALL
      SELECT 'idx ' || indexrelid::regclass::text || ' ' || pg_get_indexdef(indexrelid)
        FROM pg_index WHERE indrelid = 'public.central_needs_beneficiary_column_mappings'::regclass
      UNION ALL
      SELECT 'pol ' || polname || ' ' || polcmd::text || ' ' || polpermissive::text || ' '
             || coalesce(pg_get_expr(polqual, polrelid), '') || ' ' || coalesce(pg_get_expr(polwithcheck, polrelid), '')
        FROM pg_policy WHERE polrelid = 'public.central_needs_beneficiary_column_mappings'::regclass
    ) s(x)), true);
END;
$precondition$;

-- ----------------------------------------------------------------------------
-- 1. Safe coordinate extraction (internal).
--
--    A persisted provenance coordinate counts only when it is a JSON number
--    written as plain decimal digits (no sign, fraction or exponent) within
--    the Excel ceiling. Anything else — absent, text, 1.5, negative, above the
--    ceiling — is NULL ("not extractable"). Never raises: it is PL/pgSQL, so a
--    constant argument is never cast at plan time.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_safe_coordinate_v1(
  p_value   jsonb,
  p_ceiling integer
)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_text text;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) <> 'number' THEN
    RETURN NULL;
  END IF;
  v_text := p_value #>> '{}';
  IF v_text !~ '^[0-9]{1,9}$' THEN
    RETURN NULL;
  END IF;
  IF v_text::integer > p_ceiling THEN
    RETURN NULL;
  END IF;
  RETURN v_text::integer;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_safe_coordinate_v1(jsonb, integer) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_safe_coordinate_v1(jsonb, integer) IS
  'C4 (216) internal: the safe integral coordinate extractor. Returns the integer only for a JSON number written as plain decimal digits within p_ceiling; NULL for anything else. Never raises.';

-- 1b. M213's own coordinate cast, without the raise (internal). M213 reads a
--     column as (text)::integer; where that cast would fail this returns NULL.
--     Used only where the contract requires a cell to be judged "exactly as
--     M213 evaluates it today" (the M213 arm of the linked-cell rule and the
--     T5' collection of a converted column's linked cells).
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_m213_coordinate_v1(
  p_text text
)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN p_text::integer;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_m213_coordinate_v1(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_m213_coordinate_v1(text) IS
  'C4 (216) internal: M213''s (text)::integer coordinate cast, returning NULL where that cast would raise. Only for judging a cell exactly as M213 does.';

-- ----------------------------------------------------------------------------
-- 2. The beneficiary-region VERSION relation (B1).
-- ----------------------------------------------------------------------------
CREATE TABLE public.central_needs_beneficiary_regions (
  -- VERSION IDENTITY: one immutable decision version.
  version_id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- LOGICAL REGION IDENTITY: the lineage, minted by the server on add and
  -- copied unchanged to every successor.
  region_id                    uuid NOT NULL,
  version_no                   integer NOT NULL,
  supersedes_version_id        uuid,
  -- Binding: identical for every version of one region_id.
  plan_revision_id             uuid NOT NULL,
  -- The OWNING central organization, derived from the revision. Never the
  -- beneficiary.
  organization_id              uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  import_session_id            uuid NOT NULL,
  sheet_index                  integer NOT NULL,
  -- Geometry: 0-based, inclusive, parser-physical frame. Immutable.
  row_start                    integer NOT NULL,
  row_end                      integer NOT NULL,
  column_start                 integer NOT NULL,
  column_end                   integer NOT NULL,
  -- The explicit human decision. Immutable.
  decision                     text NOT NULL,
  beneficiary_organization_id  uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  decision_reason              text NOT NULL,
  decided_by                   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at                   timestamptz NOT NULL DEFAULT now(),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  -- The retirement stamp: empty while ACTIVE, filled at most once, completely.
  retired_at                   timestamptz,
  retired_by                   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  retirement_kind              text,
  retirement_reason            text,

  -- S1
  CONSTRAINT central_needs_beneficiary_regions_sheet_index_chk
    CHECK (sheet_index >= 0),
  -- S2
  CONSTRAINT central_needs_beneficiary_regions_row_bounds_chk
    CHECK (row_start >= 0 AND row_start <= row_end AND row_end <= 1048575),
  -- S3
  CONSTRAINT central_needs_beneficiary_regions_column_bounds_chk
    CHECK (column_start >= 0 AND column_start <= column_end AND column_end <= 16383),
  -- S4
  CONSTRAINT central_needs_beneficiary_regions_decision_chk
    CHECK (decision IN ('beneficiary', 'non_beneficiary')),
  -- S5
  CONSTRAINT central_needs_beneficiary_regions_decision_shape_chk
    CHECK ((decision = 'beneficiary') = (beneficiary_organization_id IS NOT NULL)),
  -- S6
  CONSTRAINT central_needs_beneficiary_regions_reason_chk
    CHECK (btrim(decision_reason) <> ''),
  -- S7
  CONSTRAINT central_needs_beneficiary_regions_version_no_chk
    CHECK (version_no >= 1 AND ((version_no = 1) = (supersedes_version_id IS NULL))),
  -- S8
  CONSTRAINT central_needs_beneficiary_regions_region_version_key
    UNIQUE (region_id, version_no),
  -- S9: a version has at most one successor, so a lineage never forks.
  CONSTRAINT central_needs_beneficiary_regions_supersedes_key
    UNIQUE (supersedes_version_id),
  -- Referenced by the S10 self-reference (trivially unique: version_id is the
  -- primary key).
  CONSTRAINT central_needs_beneficiary_regions_lineage_key
    UNIQUE (version_id, region_id, plan_revision_id, organization_id, import_session_id, sheet_index),
  -- S10: a successor shares its predecessor's region_id and binding columns.
  CONSTRAINT central_needs_beneficiary_regions_supersedes_fk
    FOREIGN KEY (supersedes_version_id, region_id, plan_revision_id, organization_id, import_session_id, sheet_index)
    REFERENCES public.central_needs_beneficiary_regions
      (version_id, region_id, plan_revision_id, organization_id, import_session_id, sheet_index)
    ON DELETE RESTRICT,
  -- S11: the stamp is all-or-nothing (T1 additionally requires retired_by at
  -- the moment of stamping; only the SET NULL FK may empty it later).
  CONSTRAINT central_needs_beneficiary_regions_retirement_chk
    CHECK (
      (retired_at IS NULL AND retired_by IS NULL AND retirement_kind IS NULL AND retirement_reason IS NULL)
      OR (retired_at IS NOT NULL
          AND retirement_kind IN ('replaced', 'removed')
          AND retirement_reason IS NOT NULL
          AND btrim(retirement_reason) <> '')
    ),
  -- S14: the revision's own owning organization.
  CONSTRAINT central_needs_beneficiary_regions_revision_org_fk
    FOREIGN KEY (plan_revision_id, organization_id)
    REFERENCES public.central_needs_plan_revisions (id, organization_id)
    ON DELETE RESTRICT,
  -- S15: the session belongs to THIS revision and organization.
  CONSTRAINT central_needs_beneficiary_regions_session_revision_org_fk
    FOREIGN KEY (import_session_id, plan_revision_id, organization_id)
    REFERENCES public.central_needs_import_sessions (id, plan_revision_id, organization_id)
    ON DELETE RESTRICT
);

-- S12: at most one ACTIVE version per logical region.
CREATE UNIQUE INDEX central_needs_beneficiary_regions_active_region_uidx
  ON public.central_needs_beneficiary_regions (region_id)
  WHERE retired_at IS NULL;

-- S13: at most one ACTIVE version per exact geometry. Retired versions never
-- participate, so a same-geometry replace and a later re-add stay legal.
CREATE UNIQUE INDEX central_needs_beneficiary_regions_active_geometry_uidx
  ON public.central_needs_beneficiary_regions
     (import_session_id, sheet_index, row_start, row_end, column_start, column_end)
  WHERE retired_at IS NULL;

CREATE INDEX central_needs_beneficiary_regions_revision_idx
  ON public.central_needs_beneficiary_regions (plan_revision_id);
CREATE INDEX central_needs_beneficiary_regions_org_idx
  ON public.central_needs_beneficiary_regions (organization_id);
CREATE INDEX central_needs_beneficiary_regions_beneficiary_idx
  ON public.central_needs_beneficiary_regions (beneficiary_organization_id);
CREATE INDEX central_needs_beneficiary_regions_session_idx
  ON public.central_needs_beneficiary_regions (import_session_id, sheet_index);

COMMENT ON TABLE public.central_needs_beneficiary_regions IS
  'C4 (216): immutable decision VERSIONS of human-declared beneficiary regions — one rectangle of one sheet of one import session, decided beneficiary (one care_institution) or non_beneficiary, with a mandatory reason. region_id is the logical lineage, version_id the version. ACTIVE = empty retirement stamp. Content never changes; the only mutation is one complete retirement stamp on a draft revision (and the house SET NULL of the actor columns). Never deleted, never backfilled, never inferred. Written only by phoenix_central_needs_set_beneficiary_regions.';
COMMENT ON COLUMN public.central_needs_beneficiary_regions.row_start IS
  '0-based inclusive row bound in the parser''s physical frame (hidden rows count). A whole column is 0..1048575.';
COMMENT ON COLUMN public.central_needs_beneficiary_regions.column_start IS
  '0-based inclusive column bound in the parser''s physical frame (hidden columns count), 0..16383.';
COMMENT ON COLUMN public.central_needs_beneficiary_regions.retired_at IS
  'Empty = ACTIVE. Filled exactly once, together with retired_by, retirement_kind (replaced | removed) and retirement_reason.';

ALTER TABLE public.central_needs_beneficiary_regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_beneficiary_regions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_beneficiary_regions FROM PUBLIC;
REVOKE ALL ON TABLE public.central_needs_beneficiary_regions FROM anon;
REVOKE ALL ON TABLE public.central_needs_beneficiary_regions FROM authenticated;
GRANT SELECT ON TABLE public.central_needs_beneficiary_regions TO authenticated;

CREATE POLICY central_needs_beneficiary_regions_select_authorized
  ON public.central_needs_beneficiary_regions FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));

CREATE POLICY central_needs_beneficiary_regions_role_eligible_restrictive
  ON public.central_needs_beneficiary_regions AS RESTRICTIVE FOR ALL TO authenticated
  USING (public._phoenix_central_needs_role_eligible_v1())
  WITH CHECK (public._phoenix_central_needs_role_eligible_v1());

-- ----------------------------------------------------------------------------
-- 3. The ACTIVE-version resolver (internal): for ONE source record, its safe
--    coordinates, whether its column is REGION-GOVERNED (at least one ACTIVE
--    version of the same session and sheet spans the column, whatever its
--    decision), how many ACTIVE versions cover the cell, and the covering
--    version when exactly one does. Retired versions are invisible. A cell
--    whose row cannot be safely extracted is covered by nothing.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_resolve_region_v1(
  p_import_session_id uuid,
  p_source_provenance jsonb
)
RETURNS TABLE (
  cell_sheet              integer,
  cell_row                integer,
  cell_col                integer,
  column_governed         boolean,
  covering_count          integer,
  covering_version_id     uuid,
  covering_decision       text,
  covering_beneficiary_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  cell_sheet := public._phoenix_central_needs_safe_coordinate_v1(p_source_provenance->'sheetIndex', 2147483647);
  cell_row   := public._phoenix_central_needs_safe_coordinate_v1(p_source_provenance->'coordinate'->'row', 1048575);
  cell_col   := public._phoenix_central_needs_safe_coordinate_v1(p_source_provenance->'coordinate'->'col', 16383);
  column_governed := false;
  covering_count  := 0;

  IF cell_sheet IS NOT NULL AND cell_col IS NOT NULL THEN
    column_governed := EXISTS (
      SELECT 1 FROM public.central_needs_beneficiary_regions v
       WHERE v.retired_at IS NULL
         AND v.import_session_id = p_import_session_id
         AND v.sheet_index       = cell_sheet
         AND cell_col BETWEEN v.column_start AND v.column_end);

    IF column_governed AND cell_row IS NOT NULL THEN
      SELECT count(*)::integer INTO covering_count
        FROM public.central_needs_beneficiary_regions v
       WHERE v.retired_at IS NULL
         AND v.import_session_id = p_import_session_id
         AND v.sheet_index       = cell_sheet
         AND cell_row BETWEEN v.row_start AND v.row_end
         AND cell_col BETWEEN v.column_start AND v.column_end;
      IF covering_count = 1 THEN
        SELECT v.version_id, v.decision, v.beneficiary_organization_id
          INTO covering_version_id, covering_decision, covering_beneficiary_id
          FROM public.central_needs_beneficiary_regions v
         WHERE v.retired_at IS NULL
           AND v.import_session_id = p_import_session_id
           AND v.sheet_index       = cell_sheet
           AND cell_row BETWEEN v.row_start AND v.row_end
           AND cell_col BETWEEN v.column_start AND v.column_end;
      END IF;
    END IF;
  END IF;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_resolve_region_v1(uuid, jsonb) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_resolve_region_v1(uuid, jsonb) IS
  'C4 (216) internal: the ACTIVE-version resolver. For one source record: safe coordinates, whether its column is region-governed (an ACTIVE version spans it), the number of ACTIVE versions covering the cell, and the covering version when exactly one does. Retired versions are invisible; an unlocatable cell is covered by nothing.';

-- ----------------------------------------------------------------------------
-- 4. The LINKED-CELL RULE (internal). Every need-line-linked source record of
--    one (session, sheet) that FAILS the rule, over the current state:
--      PASS  it lies inside exactly one ACTIVE 'beneficiary' version whose
--            beneficiary equals its line's beneficiary; or
--      PASS  its column has NO ACTIVE version at all and an M213
--            'beneficiary' row for that column names the line's beneficiary
--            (judged exactly as M213 judges it today).
--      FAIL  everything else — including a cell that cannot be located.
--    A linked record whose sheet cannot be determined at all is attributed to
--    every sheet of its session (it can pass neither arm), so it fails closed.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_region_linked_cell_violations_v1(
  p_import_session_id uuid,
  p_sheet_index       integer
)
RETURNS TABLE (
  source_record_id uuid,
  need_line_id     uuid,
  line_beneficiary uuid,
  failure          text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT r.id, ls.need_line_id, n.beneficiary_organization_id,
         CASE
           WHEN g.cell_sheet IS NULL OR g.cell_row IS NULL OR g.cell_col IS NULL THEN 'unlocatable'
           WHEN g.covering_count = 0 AND g.column_governed THEN 'uncovered'
           WHEN g.covering_count = 0 THEN 'undecided_column'
           WHEN g.covering_count > 1 THEN 'overlap'
           WHEN g.covering_decision IS DISTINCT FROM 'beneficiary' THEN 'not_beneficiary'
           ELSE 'beneficiary_mismatch'
         END
    FROM public.central_needs_need_line_sources ls
    JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
    JOIN public.central_needs_need_lines n     ON n.id = ls.need_line_id
    CROSS JOIN LATERAL public._phoenix_central_needs_resolve_region_v1(r.import_session_id, r.source_provenance) g
    CROSS JOIN LATERAL (
      SELECT public._phoenix_central_needs_m213_coordinate_v1(r.source_provenance->>'sheetIndex')         AS sheet_index,
             public._phoenix_central_needs_m213_coordinate_v1(r.source_provenance->'coordinate'->>'col') AS column_index
    ) m213
   WHERE r.import_session_id = p_import_session_id
     AND (m213.sheet_index = p_sheet_index OR m213.sheet_index IS NULL)
     AND NOT (
       (g.covering_count = 1
        AND g.covering_decision = 'beneficiary'
        AND g.covering_beneficiary_id = n.beneficiary_organization_id)
       OR
       (m213.sheet_index IS NOT NULL
        AND m213.column_index IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.central_needs_beneficiary_regions v
           WHERE v.retired_at IS NULL
             AND v.import_session_id = r.import_session_id
             AND v.sheet_index       = m213.sheet_index
             AND m213.column_index BETWEEN v.column_start AND v.column_end)
        AND EXISTS (
          SELECT 1 FROM public.central_needs_beneficiary_column_mappings cm
           WHERE cm.import_session_id = r.import_session_id
             AND cm.sheet_index       = m213.sheet_index
             AND cm.column_index      = m213.column_index
             AND cm.decision          = 'beneficiary'
             AND cm.beneficiary_organization_id = n.beneficiary_organization_id))
     )
   ORDER BY r.id, ls.need_line_id;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_region_linked_cell_violations_v1(uuid, integer) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_region_linked_cell_violations_v1(uuid, integer) IS
  'C4 (216) internal: the linked-cell rule. Lists every need-line-linked record of one (session, sheet) that is neither inside exactly one ACTIVE beneficiary version naming its line''s beneficiary, nor (only where its column has no ACTIVE version) covered by a matching M213 beneficiary row. Used at write (RPC step 16) and at COMMIT (T2).';

-- 4b. T5' predicate (internal): may an IN-USE M213 row of this column be
--     deleted? Only when the column is region-governed AND every linked cell
--     of that column (collected as M213 collects it) lies inside exactly one
--     ACTIVE 'beneficiary' version naming its line's beneficiary.
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_region_column_covered_v1(
  p_import_session_id uuid,
  p_sheet_index       integer,
  p_column_index      integer
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.central_needs_beneficiary_regions v
            WHERE v.retired_at IS NULL
              AND v.import_session_id = p_import_session_id
              AND v.sheet_index       = p_sheet_index
              AND p_column_index BETWEEN v.column_start AND v.column_end)
     AND NOT EXISTS (
           SELECT 1
             FROM public.central_needs_need_line_sources ls
             JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
             JOIN public.central_needs_need_lines n     ON n.id = ls.need_line_id
             CROSS JOIN LATERAL public._phoenix_central_needs_resolve_region_v1(r.import_session_id, r.source_provenance) g
            WHERE r.import_session_id = p_import_session_id
              AND public._phoenix_central_needs_m213_coordinate_v1(r.source_provenance->>'sheetIndex')         = p_sheet_index
              AND public._phoenix_central_needs_m213_coordinate_v1(r.source_provenance->'coordinate'->>'col') = p_column_index
              AND NOT (g.covering_count = 1
                       AND g.covering_decision = 'beneficiary'
                       AND g.covering_beneficiary_id = n.beneficiary_organization_id));
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_region_column_covered_v1(uuid, integer, integer) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_region_column_covered_v1(uuid, integer, integer) IS
  'C4 (216) internal, the T5'' condition: true only when the column is region-governed and every need-line-linked cell of it lies inside exactly one ACTIVE beneficiary version naming its line''s beneficiary.';

-- ----------------------------------------------------------------------------
-- 5. T1 — the version guard (BEFORE INSERT OR UPDATE OR DELETE, per row).
--
--    INSERT  only on a DRAFT revision, and only born ACTIVE.
--    UPDATE  only (a) the one-time COMPLETE retirement stamp on an ACTIVE
--            version of a DRAFT revision, every other column unchanged; or
--            (b) the house FK ON DELETE SET NULL emptying decided_by and/or
--            retired_by, every other column unchanged (any revision status).
--    DELETE  never.
--    The status is read only after a FOR SHARE lock on the owning revision
--    row, which conflicts with submit's FOR UPDATE, so a privileged bypass
--    cannot race submit. On the RPC path the same transaction already holds
--    that row FOR UPDATE, so the lock never waits.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_region_version_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status     text;
  v_actor_cols constant text[] := ARRAY['decided_by', 'retired_by'];
  v_stamp_cols constant text[] := ARRAY['retired_at', 'retired_by', 'retirement_kind', 'retirement_reason'];
  v_transition text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'beneficiary_region_version_immutable' USING ERRCODE = '23514',
      DETAIL = format('operation=delete version=%s', OLD.version_id),
      HINT = 'A region version is never deleted. Retire it through phoenix_central_needs_set_beneficiary_regions.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.retired_at IS NOT NULL OR NEW.retired_by IS NOT NULL
       OR NEW.retirement_kind IS NOT NULL OR NEW.retirement_reason IS NOT NULL THEN
      RAISE EXCEPTION 'beneficiary_region_version_immutable' USING ERRCODE = '23514',
        DETAIL = format('operation=insert version=%s transition=born_retired', NEW.version_id),
        HINT = 'A region version is always born ACTIVE.';
    END IF;
    SELECT r.status INTO v_status
      FROM public.central_needs_plan_revisions r
     WHERE r.id = NEW.plan_revision_id
       FOR SHARE;
    IF v_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'plan_revision_not_editable' USING ERRCODE = '23514',
        DETAIL = format('revision=%s status=%s operation=insert', NEW.plan_revision_id, coalesce(v_status, '(none)')),
        HINT = 'Only a draft revision accepts region versions.';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE (b): the FK-driven actor nulling. Attribution only; no status read.
  IF (to_jsonb(NEW) - v_actor_cols) = (to_jsonb(OLD) - v_actor_cols)
     AND (NEW.decided_by IS NOT DISTINCT FROM OLD.decided_by OR NEW.decided_by IS NULL)
     AND (NEW.retired_by IS NOT DISTINCT FROM OLD.retired_by OR NEW.retired_by IS NULL)
     AND ((OLD.decided_by IS NOT NULL AND NEW.decided_by IS NULL)
          OR (OLD.retired_by IS NOT NULL AND NEW.retired_by IS NULL)) THEN
    RETURN NEW;
  END IF;

  -- UPDATE (a): the one-time, complete retirement stamp.
  IF (to_jsonb(NEW) - v_stamp_cols) = (to_jsonb(OLD) - v_stamp_cols)
     AND OLD.retired_at IS NULL AND OLD.retired_by IS NULL
     AND OLD.retirement_kind IS NULL AND OLD.retirement_reason IS NULL
     AND NEW.retired_at IS NOT NULL AND NEW.retired_by IS NOT NULL
     AND NEW.retirement_kind IN ('replaced', 'removed')
     AND NEW.retirement_reason IS NOT NULL AND btrim(NEW.retirement_reason) <> '' THEN
    SELECT r.status INTO v_status
      FROM public.central_needs_plan_revisions r
     WHERE r.id = NEW.plan_revision_id
       FOR SHARE;
    IF v_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'plan_revision_not_editable' USING ERRCODE = '23514',
        DETAIL = format('revision=%s status=%s operation=retire version=%s',
                        NEW.plan_revision_id, coalesce(v_status, '(none)'), NEW.version_id),
        HINT = 'Only a draft revision''s region versions can be retired.';
    END IF;
    RETURN NEW;
  END IF;

  v_transition := CASE
    WHEN OLD.retired_at IS NOT NULL AND NEW.retired_at IS NULL THEN 'un_retire'
    WHEN OLD.retired_at IS NOT NULL THEN 'second_stamp'
    WHEN (to_jsonb(NEW) - v_stamp_cols) = (to_jsonb(OLD) - v_stamp_cols) THEN 'incomplete_stamp'
    ELSE 'content_change'
  END;
  RAISE EXCEPTION 'beneficiary_region_version_immutable' USING ERRCODE = '23514',
    DETAIL = format('operation=update version=%s transition=%s', OLD.version_id, v_transition),
    HINT = 'A region version''s content never changes; its only update is one complete retirement stamp.';
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_region_version_guard_v1() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_region_version_guard_v1() IS
  'C4 (216) T1: draft-only, born-ACTIVE inserts; the one-time complete retirement stamp on a draft revision and the house FK actor nulling as the only updates; no delete. Reads the revision status under FOR SHARE.';

CREATE TRIGGER central_needs_beneficiary_regions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.central_needs_beneficiary_regions
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_central_needs_region_version_guard_v1();

-- ----------------------------------------------------------------------------
-- 6. The geometry-and-lineage assertion (internal), run by two deferred
--    constraint triggers:
--      T3 on the version relation (after a version insert or stamp):
--         overlap (beneficiary_region_overlap), X1
--         (beneficiary_decision_grain_conflict) over the ACTIVE versions of
--         the touched (session, sheet), and the lineage clause
--         (beneficiary_region_lineage_invalid) of the touched region;
--      T4 on the EXISTING M213 table (after insert or update): X1 against
--         ACTIVE versions (beneficiary_decision_grain_conflict).
--    Both re-read current state at COMMIT; retired versions never count.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_assert_region_geometry_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mapping public.central_needs_beneficiary_column_mappings%ROWTYPE;
  v_bad     record;
BEGIN
  IF TG_TABLE_NAME = 'central_needs_beneficiary_column_mappings' THEN
    -- T4. The row as it stands at COMMIT (a later delete in the same
    -- transaction leaves nothing to conflict).
    SELECT * INTO v_mapping
      FROM public.central_needs_beneficiary_column_mappings
     WHERE id = NEW.id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    SELECT v.version_id INTO v_bad
      FROM public.central_needs_beneficiary_regions v
     WHERE v.retired_at IS NULL
       AND v.import_session_id = v_mapping.import_session_id
       AND v.sheet_index       = v_mapping.sheet_index
       AND v_mapping.column_index BETWEEN v.column_start AND v.column_end
     ORDER BY v.version_id
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'beneficiary_decision_grain_conflict' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s mapping=%s region=%s',
                        v_mapping.import_session_id, v_mapping.sheet_index, v_mapping.column_index,
                        v_mapping.id, v_bad.version_id),
        HINT = 'This physical column is governed by beneficiary regions. Retire those regions first, or keep the column in regions; one column is never governed by both.';
    END IF;
    RETURN NULL;
  END IF;

  -- T3. Only inserts and the retirement stamp change geometry or lineage; the
  -- FK actor nulling does not.
  IF TG_OP = 'UPDATE' AND NOT (OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL) THEN
    RETURN NULL;
  END IF;

  SELECT a.version_id AS a_id, b.version_id AS b_id INTO v_bad
    FROM public.central_needs_beneficiary_regions a
    JOIN public.central_needs_beneficiary_regions b
      ON b.import_session_id = a.import_session_id
     AND b.sheet_index       = a.sheet_index
     AND b.retired_at IS NULL
     AND a.version_id < b.version_id
     AND a.row_start <= b.row_end AND b.row_start <= a.row_end
     AND a.column_start <= b.column_end AND b.column_start <= a.column_end
   WHERE a.retired_at IS NULL
     AND a.import_session_id = NEW.import_session_id
     AND a.sheet_index       = NEW.sheet_index
   ORDER BY a.version_id, b.version_id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'beneficiary_region_overlap' USING ERRCODE = '23514',
      DETAIL = format('session=%s sheet=%s region=%s other_region=%s',
                      NEW.import_session_id, NEW.sheet_index, v_bad.a_id, v_bad.b_id),
      HINT = 'Two ACTIVE regions of one sheet share a cell. Every cell resolves to at most one decision.';
  END IF;

  SELECT v.version_id, m.id AS mapping_id, m.column_index INTO v_bad
    FROM public.central_needs_beneficiary_regions v
    JOIN public.central_needs_beneficiary_column_mappings m
      ON m.import_session_id = v.import_session_id
     AND m.sheet_index       = v.sheet_index
     AND m.column_index BETWEEN v.column_start AND v.column_end
   WHERE v.retired_at IS NULL
     AND v.import_session_id = NEW.import_session_id
     AND v.sheet_index       = NEW.sheet_index
   ORDER BY v.version_id, m.column_index
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'beneficiary_decision_grain_conflict' USING ERRCODE = '23514',
      DETAIL = format('session=%s sheet=%s column=%s mapping=%s region=%s',
                      NEW.import_session_id, NEW.sheet_index, v_bad.column_index, v_bad.mapping_id, v_bad.version_id),
      HINT = 'An ACTIVE region spans a column that still has an M213 decision. One column is never governed by both.';
  END IF;

  -- Lineage clause of the touched region.
  SELECT c.version_id, 'successor_not_after_replaced_predecessor' AS problem INTO v_bad
    FROM public.central_needs_beneficiary_regions c
    JOIN public.central_needs_beneficiary_regions p ON p.version_id = c.supersedes_version_id
   WHERE c.region_id = NEW.region_id
     AND (c.version_no <> p.version_no + 1 OR p.retirement_kind IS DISTINCT FROM 'replaced')
  UNION ALL
  SELECT p.version_id, 'replaced_without_successor'
    FROM public.central_needs_beneficiary_regions p
   WHERE p.region_id = NEW.region_id
     AND p.retirement_kind = 'replaced'
     AND NOT EXISTS (SELECT 1 FROM public.central_needs_beneficiary_regions c
                      WHERE c.supersedes_version_id = p.version_id)
  UNION ALL
  SELECT p.version_id, 'removed_with_successor'
    FROM public.central_needs_beneficiary_regions p
   WHERE p.region_id = NEW.region_id
     AND p.retirement_kind = 'removed'
     AND EXISTS (SELECT 1 FROM public.central_needs_beneficiary_regions c
                  WHERE c.supersedes_version_id = p.version_id)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'beneficiary_region_lineage_invalid' USING ERRCODE = '23514',
      DETAIL = format('region=%s version=%s problem=%s', NEW.region_id, v_bad.version_id, v_bad.problem),
      HINT = 'A successor is version n+1 of a predecessor retired as replaced; a replaced version has exactly one successor and a removed version none.';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_region_geometry_v1() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_assert_region_geometry_v1() IS
  'C4 (216) T3/T4: at COMMIT, over ACTIVE versions only — no two intersecting ACTIVE versions in one (session, sheet), no ACTIVE version spanning a column that has an M213 row (X1), and a well-formed lineage. Attached to the version relation (T3) and to the M213 table (T4, X1 only).';

-- T3.
CREATE CONSTRAINT TRIGGER assert_beneficiary_region_geometry
  AFTER INSERT OR UPDATE ON public.central_needs_beneficiary_regions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_central_needs_assert_region_geometry_v1();

-- T4: the one object this migration adds on the M213 table. It narrows what
-- the UNCHANGED set_beneficiary_columns can commit (X1), with a COMMIT-time
-- code outside M213's vocabulary, and changes the meaning of no M213 row.
CREATE CONSTRAINT TRIGGER assert_beneficiary_region_grain
  AFTER INSERT OR UPDATE ON public.central_needs_beneficiary_column_mappings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_central_needs_assert_region_geometry_v1();

-- ----------------------------------------------------------------------------
-- 8. Behaviour-only replacement of _phoenix_central_needs_assert_need_line_integrity_v1
--    (M213 body reproduced verbatim; three additions, each marked "216"):
--      (a) a region-table branch — a version insert or retirement stamp
--          re-checks the linked-cell rule for EVERY linked cell of the
--          touched (session, sheet) (beneficiary_region_in_use);
--      (b) a per-line region clause (beneficiary_region_mapping_conflict);
--      T5' the mapping-table DELETE branch permits an in-use delete ONLY for
--          a region-governed, fully covered column; otherwise M213's
--          unchanged beneficiary_column_mapping_in_use.
--    Every other behaviour is unchanged. Then T2 attaches it to the new
--    relation, mirroring M213's own deferred trigger on its table.
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
  v_bad_region record;
  v_scope_session uuid;
  v_scope_sheet   integer;
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
    --
    -- 216 T5' — the ONE permitted case of an in-use delete: the governed
    -- convert_column path, judged at COMMIT. It passes only when the column
    -- is region-governed and every linked cell of it lies inside exactly one
    -- ACTIVE beneficiary region naming its line's beneficiary. Anything else
    -- keeps the unchanged refusal below.
    IF TG_OP = 'DELETE' AND cardinality(v_line_ids) > 0
       AND NOT public._phoenix_central_needs_region_column_covered_v1(
             OLD.import_session_id, OLD.sheet_index, OLD.column_index) THEN
      RAISE EXCEPTION 'beneficiary_column_mapping_in_use' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s need_lines=%s',
                        OLD.import_session_id, OLD.sheet_index, OLD.column_index, v_line_ids),
        HINT = 'This physical column already feeds one or more need lines and cannot be unmapped directly.';
    END IF;
  ELSIF TG_TABLE_NAME = 'central_needs_beneficiary_regions' THEN
    -- 216 ADDITION (a) — a region version was inserted or retired. Only those
    -- two events change coverage; the FK actor nulling (T1 transition (b))
    -- does not, and a delete is impossible (T1). Every need-line-linked cell
    -- of the touched (session, sheet) must pass the linked-cell rule in the
    -- state being committed — not only cells of the changed rectangle.
    IF TG_OP = 'UPDATE' AND NOT (OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL) THEN
      RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN
      v_scope_session := OLD.import_session_id;
      v_scope_sheet   := OLD.sheet_index;
    ELSE
      v_scope_session := NEW.import_session_id;
      v_scope_sheet   := NEW.sheet_index;
    END IF;
    SELECT * INTO v_bad_region
      FROM public._phoenix_central_needs_region_linked_cell_violations_v1(v_scope_session, v_scope_sheet)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'beneficiary_region_in_use' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s source_record=%s need_line=%s line_beneficiary=%s failure=%s',
                        v_scope_session, v_scope_sheet, v_bad_region.source_record_id,
                        v_bad_region.need_line_id, v_bad_region.line_beneficiary, v_bad_region.failure),
        HINT = 'A cell already feeding a need line would lose or switch its beneficiary region.';
    END IF;
    SELECT coalesce(array_agg(DISTINCT ls.need_line_id), ARRAY[]::uuid[])
      INTO v_line_ids
      FROM public.central_needs_need_line_sources ls
      JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
     WHERE r.import_session_id = v_scope_session
       AND (public._phoenix_central_needs_m213_coordinate_v1(r.source_provenance->>'sheetIndex') = v_scope_sheet
            OR public._phoenix_central_needs_m213_coordinate_v1(r.source_provenance->>'sheetIndex') IS NULL);
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

    -- 216 ADDITION (b) — every linked cell in a REGION-GOVERNED column must lie
    -- inside exactly one ACTIVE beneficiary region naming this line's
    -- beneficiary. A cell there whose row cannot be located also fails.
    -- Columns no ACTIVE region spans are judged by the M213 clause above only.
    SELECT r.id AS source_record_id, g.covering_count, g.covering_decision,
           g.covering_beneficiary_id
      INTO v_bad_region
      FROM public.central_needs_need_line_sources ls
      JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
      CROSS JOIN LATERAL public._phoenix_central_needs_resolve_region_v1(r.import_session_id, r.source_provenance) g
     WHERE ls.need_line_id = v_line.id
       AND g.column_governed
       AND NOT (g.covering_count = 1
                AND g.covering_decision = 'beneficiary'
                AND g.covering_beneficiary_id = v_line.beneficiary_organization_id)
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'beneficiary_region_mapping_conflict' USING ERRCODE = '23514',
        DETAIL = format('need_line=%s source_record=%s covering_regions=%s region_decision=%s region_beneficiary=%s line_beneficiary=%s',
                        v_line.id, v_bad_region.source_record_id, v_bad_region.covering_count,
                        coalesce(v_bad_region.covering_decision, '(none)'),
                        coalesce(v_bad_region.covering_beneficiary_id::text, '(none)'),
                        v_line.beneficiary_organization_id),
        HINT = 'This linked cell''s ACTIVE beneficiary region does not name the line''s beneficiary. Correct the line through the explicit delete path.';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1()
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1() IS
  'CN-2B (212, extended by 213, and by 216): the deferred assertion that every need line a row change touched keeps mandatory source lineage, a designated-quantity sum equal to its approved quantity, canonical material agreement, no institution-level/warehouse-split mixture, (213) beneficiary-column-mapping agreement for every linked cell, and (216) beneficiary-REGION agreement for every linked cell in a region-governed column. (216) A region version insert or retirement re-checks the linked-cell rule for every linked cell of its (session, sheet); an in-use M213 row may be deleted only when its column is region-governed and every linked cell of it is covered by exactly one ACTIVE beneficiary region naming the line''s beneficiary (T5''). Runs at COMMIT, so it binds every write path rather than one RPC.';

-- T2.
CREATE CONSTRAINT TRIGGER assert_need_line_integrity
  AFTER INSERT OR UPDATE OR DELETE ON public.central_needs_beneficiary_regions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1();

-- ----------------------------------------------------------------------------
-- 9. Behaviour-only replacement of phoenix_central_needs_set_need_line
--    (identical 11-argument signature; M213 body reproduced verbatim; the one
--    change is the per-cell beneficiary step, marked "216 GENERALIZATION").
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
  v_cell         record;
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
    -- 216 GENERALIZATION — the per-cell beneficiary grain. The ONLY change to
    -- this function: (i) safe extraction of the cell's sheet and column —
    -- none means no decision; (ii) the grain decision: region-governed when
    -- an ACTIVE region spans the column; (iii) both grains on one column is a
    -- conflict; (iv) otherwise the UNCHANGED M213 resolver and three codes
    -- below, now always reached with known integers; (v) a region-governed
    -- column resolves through its ACTIVE versions only.
    -- =========================================================================
    SELECT * INTO v_cell
      FROM public._phoenix_central_needs_resolve_region_v1(v_record.import_session_id, v_record.source_provenance);
    IF v_cell.cell_sheet IS NULL OR v_cell.cell_col IS NULL THEN
      RAISE EXCEPTION 'beneficiary_column_mapping_required' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s session=%s', v_record_id, v_record.import_session_id),
        HINT = 'Confirm this physical column''s beneficiary through phoenix_central_needs_set_beneficiary_columns before designating any of its cells.';
    END IF;
    IF v_cell.column_governed THEN
      IF EXISTS (
        SELECT 1 FROM public.central_needs_beneficiary_column_mappings cm
         WHERE cm.import_session_id = v_record.import_session_id
           AND cm.sheet_index       = v_cell.cell_sheet
           AND cm.column_index      = v_cell.cell_col
      ) THEN
        RAISE EXCEPTION 'beneficiary_decision_grain_conflict' USING ERRCODE = '23514',
          DETAIL = format('source_record=%s session=%s sheet=%s column=%s',
                          v_record_id, v_record.import_session_id, v_cell.cell_sheet, v_cell.cell_col),
          HINT = 'This column is governed both by an M213 decision and by beneficiary regions. Nothing can be designated until one grain remains.';
      END IF;
      IF v_cell.covering_count = 0 THEN
        RAISE EXCEPTION 'beneficiary_region_required' USING ERRCODE = '23514',
          DETAIL = format('source_record=%s session=%s sheet=%s row=%s column=%s',
                          v_record_id, v_record.import_session_id, v_cell.cell_sheet,
                          coalesce(v_cell.cell_row::text, '(unidentified)'), v_cell.cell_col),
          HINT = 'This cell''s column is decided by beneficiary regions, and no ACTIVE region covers this cell. Declare one through phoenix_central_needs_set_beneficiary_regions first.';
      END IF;
      IF v_cell.covering_count > 1 THEN
        RAISE EXCEPTION 'beneficiary_region_overlap' USING ERRCODE = '23514',
          DETAIL = format('source_record=%s session=%s covering_regions=%s',
                          v_record_id, v_record.import_session_id, v_cell.covering_count),
          HINT = 'More than one ACTIVE region covers this cell. There is no precedence; the overlap must be resolved first.';
      END IF;
      IF v_cell.covering_decision IS DISTINCT FROM 'beneficiary' THEN
        RAISE EXCEPTION 'beneficiary_region_not_beneficiary' USING ERRCODE = '23514',
          DETAIL = format('source_record=%s session=%s region=%s decision=%s',
                          v_record_id, v_record.import_session_id, v_cell.covering_version_id, v_cell.covering_decision),
          HINT = 'This cell lies in a region explicitly reviewed as not a beneficiary. It is reviewed evidence, never a need-line source.';
      END IF;
      IF v_cell.covering_beneficiary_id IS DISTINCT FROM p_beneficiary_organization_id THEN
        RAISE EXCEPTION 'beneficiary_region_mapping_conflict' USING ERRCODE = '23514',
          DETAIL = format('source_record=%s region=%s region_beneficiary=%s requested_beneficiary=%s',
                          v_record_id, v_cell.covering_version_id, v_cell.covering_beneficiary_id, p_beneficiary_organization_id),
          HINT = 'This cell''s ACTIVE region belongs to a different beneficiary. A source cell cannot feed a need line for another institution.';
      END IF;
    ELSE
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
    END IF;
    -- ========================================================= end 216 generalization

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
  'CN-2B (212, extended by 213 and 216): identical public contract to M212. For every designated source record the cell''s beneficiary is proven server-side at the cell''s grain: its sheet and column must be safely locatable; a column that an ACTIVE beneficiary region spans resolves through exactly one covering ACTIVE region (beneficiary_region_required / _overlap / _not_beneficiary / _mapping_conflict), and a column with an M213 row and a region is a conflict (beneficiary_decision_grain_conflict); every other column keeps M213''s unchanged confirmed-column rule (beneficiary_column_mapping_required / _not_beneficiary / _mapping_conflict). Every other M212 check is reproduced unchanged.';

-- ----------------------------------------------------------------------------
-- 7. THE ONE PUBLIC WRITE RPC: phoenix_central_needs_set_beneficiary_regions.
--
--    One call = one transaction over ONE (import_session_id, sheet_index), in
--    this fixed order:
--       1-7   auth, revision FOR UPDATE, guard, org live, draft, newest
--             revision, reason
--       8-10  operation shape, session, refuse-only witnesses
--       11    stale fences (exact ACTIVE version-id set; exact M213 fence)
--       12    every per-item validation
--       ---- first write ----
--       13    M213 conversions (fenced delete)
--       14    retirement stamps
--       15    new version inserts
--       16    final-state checks (overlap, X1, converted columns, linked cells)
--       17    audit
--       18    return
--    Any refusal anywhere, including a deferred COMMIT trigger, rolls the whole
--    transaction back: zero mutation, zero audit. Never an automatic retry.
--
--    p_changes items (camelCase):
--      {op:'add',     rowStart,rowEnd,columnStart,columnEnd, decision, beneficiaryOrganizationId}
--      {op:'replace', versionId, rowStart,rowEnd,columnStart,columnEnd, decision, beneficiaryOrganizationId}
--      {op:'remove',  versionId}
--      {op:'convert_column', columnIndex, expectedMappingId, previousDecision,
--                            previousBeneficiaryOrganizationId (uuid | null), previousMappedAt,
--                            [importSessionId], [sheetIndex]}
--    Geometry and beneficiary are ALWAYS explicit human input. Nothing is ever
--    copied or inferred from an M213 row.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_set_beneficiary_regions(
  p_plan_revision_id         uuid,
  p_import_session_id        uuid,
  p_sheet_index              numeric,
  p_rendered_parser_identity jsonb,
  p_expected_sheet_name      text,
  p_expected_version_ids     uuid[],
  p_changes                  jsonb,
  p_reason                   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_uuid        constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  c_integral    constant text := '^-?[0-9]+$';
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_revision    public.central_needs_plan_revisions%ROWTYPE;
  v_reason      text;
  v_session     public.central_needs_import_sessions%ROWTYPE;
  v_sheet       integer;
  v_now         timestamptz := now();
  v_batch_id    uuid := gen_random_uuid();
  v_expected    uuid[];
  v_active      uuid[];
  v_item        jsonb;
  v_ord         bigint;
  v_op          text;
  v_key         text;
  v_items       jsonb := '[]'::jsonb;
  v_plan        jsonb := '[]'::jsonb;
  v_n           jsonb;
  v_seen_ids    uuid[] := ARRAY[]::uuid[];
  v_seen_cols   integer[] := ARRAY[]::integer[];
  v_conv_cols   integer[] := ARRAY[]::integer[];
  v_targets     uuid[] := ARRAY[]::uuid[];
  v_appear      text[] := ARRAY[]::text[];
  v_vid         uuid;
  v_col         integer;
  v_rs          integer;
  v_re          integer;
  v_cs          integer;
  v_ce          integer;
  v_decision    text;
  v_ben         uuid;
  v_new_key     text;
  v_old_key     text;
  v_target      public.central_needs_beneficiary_regions%ROWTYPE;
  v_mapping     public.central_needs_beneficiary_column_mappings%ROWTYPE;
  v_bad         record;
  v_rows        integer;
  v_new_id      uuid;
  v_region_id   uuid;
  v_constraint  text;
  v_new_ids     jsonb := '{}'::jsonb;
  v_snapshots   jsonb := '{}'::jsonb;
  v_changes     jsonb := '[]'::jsonb;
  v_converted   jsonb := '[]'::jsonb;
  v_active_out  jsonb;
BEGIN
  -- ---- 1. authenticated ----------------------------------------------------
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- ---- 2. the revision row, FOR UPDATE (serializes every content writer) --
  v_revision := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);

  -- ---- 3. role class, then capability --------------------------------------
  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.edit');

  -- ---- 4. live organization -------------------------------------------------
  PERFORM public._phoenix_central_needs_assert_org_live_v1(v_revision.organization_id);

  -- ---- 5. draft only (also makes convert_column draft-only) ---------------
  PERFORM public._phoenix_central_needs_assert_draft_v1(v_revision.id, v_revision.status);

  -- ---- 6. expected-latest-revision fence: read-only, no family/plan lock --
  IF EXISTS (
    SELECT 1 FROM public.central_needs_plan_revisions o
     WHERE o.plan_id = v_revision.plan_id
       AND o.revision_number > v_revision.revision_number
  ) THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('revision=%s (revision %s) is not the newest revision of plan=%s',
                      v_revision.id, v_revision.revision_number, v_revision.plan_id);
  END IF;

  -- ---- 7. mandatory reason ----------------------------------------------------
  v_reason := public._phoenix_central_needs_human_text_v1(p_reason);
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'mapping_reason_required' USING ERRCODE = '23514';
  END IF;

  -- ---- 8. operation shape -------------------------------------------------------
  IF p_expected_version_ids IS NULL
     OR array_position(p_expected_version_ids, NULL) IS NOT NULL
     OR cardinality(p_expected_version_ids)
          <> (SELECT count(DISTINCT e) FROM unnest(p_expected_version_ids) AS e) THEN
    RAISE EXCEPTION 'beneficiary_region_expected_ids_required' USING ERRCODE = '23514',
      HINT = 'State the complete set of ACTIVE region version ids you last loaded for this sheet — an empty array when you believe there are none. No nulls, no duplicates.';
  END IF;

  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'array' OR jsonb_array_length(p_changes) = 0 THEN
    RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
      DETAIL = 'changes must be a non-empty array';
  END IF;

  FOR v_item, v_ord IN SELECT e, o FROM jsonb_array_elements(p_changes) WITH ORDINALITY AS t(e, o)
  LOOP
    IF jsonb_typeof(v_item) <> 'object' OR jsonb_typeof(v_item->'op') IS DISTINCT FROM 'string'
       OR (v_item->>'op') NOT IN ('add', 'replace', 'remove', 'convert_column') THEN
      RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
        DETAIL = format('item=%s field=op', v_ord);
    END IF;
    v_op := v_item->>'op';
    v_n  := jsonb_build_object('ord', v_ord, 'op', v_op);

    IF v_op IN ('replace', 'remove') THEN
      IF jsonb_typeof(v_item->'versionId') IS DISTINCT FROM 'string' OR (v_item->>'versionId') !~ c_uuid THEN
        RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
          DETAIL = format('item=%s field=versionId', v_ord);
      END IF;
      v_vid := (v_item->>'versionId')::uuid;
      IF v_vid = ANY (v_seen_ids) THEN
        RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
          DETAIL = format('item=%s field=versionId version=%s named_more_than_once', v_ord, v_vid);
      END IF;
      v_seen_ids := v_seen_ids || v_vid;
      v_n := v_n || jsonb_build_object('versionId', v_vid);
    END IF;

    IF v_op IN ('add', 'replace') THEN
      FOREACH v_key IN ARRAY ARRAY['rowStart', 'rowEnd', 'columnStart', 'columnEnd'] LOOP
        IF jsonb_typeof(v_item->v_key) IS DISTINCT FROM 'number' OR (v_item->>v_key) !~ c_integral THEN
          RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
            DETAIL = format('item=%s field=%s must be an integral JSON number', v_ord, v_key);
        END IF;
      END LOOP;
      IF (v_item ? 'beneficiaryOrganizationId')
         AND jsonb_typeof(v_item->'beneficiaryOrganizationId') <> 'null'
         AND (jsonb_typeof(v_item->'beneficiaryOrganizationId') <> 'string'
              OR (v_item->>'beneficiaryOrganizationId') !~ c_uuid) THEN
        RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
          DETAIL = format('item=%s field=beneficiaryOrganizationId', v_ord);
      END IF;
      v_n := v_n || jsonb_build_object(
        'rowStart', v_item->'rowStart', 'rowEnd', v_item->'rowEnd',
        'columnStart', v_item->'columnStart', 'columnEnd', v_item->'columnEnd',
        'decision', coalesce(v_item->'decision', 'null'::jsonb),
        'beneficiaryOrganizationId', CASE
          WHEN jsonb_typeof(v_item->'beneficiaryOrganizationId') = 'string'
            THEN to_jsonb((v_item->>'beneficiaryOrganizationId')::uuid)
          ELSE 'null'::jsonb END);
    END IF;

    IF v_op = 'convert_column' THEN
      IF jsonb_typeof(v_item->'columnIndex') IS DISTINCT FROM 'number'
         OR (v_item->>'columnIndex') !~ c_integral
         OR (v_item->>'columnIndex')::numeric < 0
         OR (v_item->>'columnIndex')::numeric > 16383 THEN
        RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
          DETAIL = format('item=%s field=columnIndex must be an integer 0..16383', v_ord);
      END IF;
      v_col := (v_item->>'columnIndex')::integer;
      IF v_col = ANY (v_seen_cols) THEN
        RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
          DETAIL = format('item=%s field=columnIndex column=%s converted_more_than_once', v_ord, v_col);
      END IF;
      v_seen_cols := v_seen_cols || v_col;
      IF jsonb_typeof(v_item->'expectedMappingId') IS DISTINCT FROM 'string'
         OR (v_item->>'expectedMappingId') !~ c_uuid THEN
        RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
          DETAIL = format('item=%s field=expectedMappingId', v_ord);
      END IF;
      IF jsonb_typeof(v_item->'previousDecision') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
          DETAIL = format('item=%s field=previousDecision', v_ord);
      END IF;
      IF NOT (v_item ? 'previousBeneficiaryOrganizationId')
         OR (jsonb_typeof(v_item->'previousBeneficiaryOrganizationId') <> 'null'
             AND (jsonb_typeof(v_item->'previousBeneficiaryOrganizationId') <> 'string'
                  OR (v_item->>'previousBeneficiaryOrganizationId') !~ c_uuid)) THEN
        RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
          DETAIL = format('item=%s field=previousBeneficiaryOrganizationId', v_ord);
      END IF;
      IF jsonb_typeof(v_item->'previousMappedAt') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
          DETAIL = format('item=%s field=previousMappedAt', v_ord);
      END IF;
      BEGIN
        PERFORM (v_item->>'previousMappedAt')::timestamptz;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
          DETAIL = format('item=%s field=previousMappedAt is not a timestamp', v_ord);
      END;
      -- Optional scope witnesses: when present they must state exactly the
      -- call scope.
      IF (v_item ? 'importSessionId')
         AND (jsonb_typeof(v_item->'importSessionId') IS DISTINCT FROM 'string'
              OR (v_item->>'importSessionId') !~ c_uuid
              OR (v_item->>'importSessionId')::uuid IS DISTINCT FROM p_import_session_id) THEN
        RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
          DETAIL = format('item=%s field=importSessionId must equal the call scope', v_ord);
      END IF;
      IF (v_item ? 'sheetIndex')
         AND (jsonb_typeof(v_item->'sheetIndex') IS DISTINCT FROM 'number'
              OR (v_item->>'sheetIndex')::numeric IS DISTINCT FROM p_sheet_index) THEN
        RAISE EXCEPTION 'beneficiary_region_operation_invalid' USING ERRCODE = '23514',
          DETAIL = format('item=%s field=sheetIndex must equal the call scope', v_ord);
      END IF;
      v_n := v_n || jsonb_build_object(
        'columnIndex', v_col,
        'expectedMappingId', v_item->>'expectedMappingId',
        'previousDecision', v_item->>'previousDecision',
        'previousBeneficiaryOrganizationId', v_item->'previousBeneficiaryOrganizationId',
        'previousMappedAt', v_item->>'previousMappedAt');
      v_conv_cols := v_conv_cols || v_col;
    END IF;

    v_items := v_items || jsonb_build_array(v_n);
  END LOOP;

  -- ---- 9. the session and the sheet ------------------------------------------
  SELECT * INTO v_session
    FROM public.central_needs_import_sessions
   WHERE id = p_import_session_id
     AND plan_revision_id = v_revision.id
     AND organization_id  = v_revision.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'beneficiary_region_session_not_in_revision' USING ERRCODE = '23514',
      DETAIL = format('session=%s revision=%s', p_import_session_id, v_revision.id);
  END IF;
  IF v_session.status <> 'completed' THEN
    RAISE EXCEPTION 'beneficiary_region_session_not_completed' USING ERRCODE = '23514',
      DETAIL = format('session=%s status=%s', v_session.id, v_session.status);
  END IF;
  IF p_sheet_index IS NULL OR p_sheet_index <> trunc(p_sheet_index)
     OR p_sheet_index < 0 OR p_sheet_index > 2147483647 THEN
    RAISE EXCEPTION 'beneficiary_region_sheet_index_invalid' USING ERRCODE = '23514',
      DETAIL = format('session=%s sheet=%s', v_session.id, coalesce(p_sheet_index::text, '(null)'));
  END IF;
  v_sheet := p_sheet_index::integer;
  IF NOT EXISTS (
    SELECT 1 FROM public.central_needs_source_records r
     WHERE r.import_session_id = v_session.id
       AND public._phoenix_central_needs_safe_coordinate_v1(r.source_provenance->'sheetIndex', 2147483647) = v_sheet
  ) THEN
    RAISE EXCEPTION 'beneficiary_region_sheet_index_invalid' USING ERRCODE = '23514',
      DETAIL = format('session=%s sheet=%s has no persisted source record', v_session.id, v_sheet);
  END IF;

  -- ---- 10. refuse-only witnesses (client-asserted; never persisted) --------
  IF p_rendered_parser_identity IS NULL
     OR jsonb_typeof(p_rendered_parser_identity) <> 'object'
     OR v_session.parser_identity IS NULL
     OR (p_rendered_parser_identity->>'contractVersion') IS NULL
     OR (p_rendered_parser_identity->>'sheetjsVersion') IS NULL
     OR (p_rendered_parser_identity->>'sheetjsTarballSha256') IS NULL
     OR (p_rendered_parser_identity->>'contractVersion')      IS DISTINCT FROM (v_session.parser_identity->>'contractVersion')
     OR (p_rendered_parser_identity->>'sheetjsVersion')       IS DISTINCT FROM (v_session.parser_identity->>'sheetjsVersion')
     OR (p_rendered_parser_identity->>'sheetjsTarballSha256') IS DISTINCT FROM (v_session.parser_identity->>'sheetjsTarballSha256') THEN
    RAISE EXCEPTION 'beneficiary_region_parser_identity_mismatch' USING ERRCODE = '23514',
      DETAIL = format('session=%s', v_session.id),
      HINT = 'The grid you are looking at was not rendered by the parser that imported this session. Nothing was written.';
  END IF;
  IF p_expected_sheet_name IS NULL OR EXISTS (
    SELECT 1 FROM public.central_needs_source_records r
     WHERE r.import_session_id = v_session.id
       AND public._phoenix_central_needs_safe_coordinate_v1(r.source_provenance->'sheetIndex', 2147483647) = v_sheet
       AND (r.source_provenance->>'sheetName') IS DISTINCT FROM p_expected_sheet_name
  ) THEN
    RAISE EXCEPTION 'beneficiary_region_sheet_mismatch' USING ERRCODE = '23514',
      DETAIL = format('session=%s sheet=%s', v_session.id, v_sheet),
      HINT = 'The sheet name you saw is not the persisted sheet name of this sheet index. Nothing was written.';
  END IF;

  -- ---- 11. STALE FENCES, under the revision lock ------------------------------
  -- 11a. the exact ACTIVE version-id set of the scope.
  SELECT coalesce(array_agg(v.version_id ORDER BY v.version_id), ARRAY[]::uuid[])
    INTO v_active
    FROM public.central_needs_beneficiary_regions v
   WHERE v.import_session_id = v_session.id
     AND v.sheet_index       = v_sheet
     AND v.retired_at IS NULL;
  SELECT coalesce(array_agg(e ORDER BY e), ARRAY[]::uuid[])
    INTO v_expected
    FROM unnest(p_expected_version_ids) AS e;
  IF v_active IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'beneficiary_region_stale' USING ERRCODE = '23514',
      DETAIL = format('session=%s sheet=%s expected_active=%s current_active=%s',
                      v_session.id, v_sheet, cardinality(v_expected), cardinality(v_active)),
      HINT = 'The regions of this sheet changed since you loaded them. Reload and decide again; nothing was written.';
  END IF;

  -- 11b. the exact, null-safe M213 fence of every converted column.
  FOR v_n IN SELECT e FROM jsonb_array_elements(v_items) AS e WHERE e->>'op' = 'convert_column'
  LOOP
    SELECT * INTO v_mapping
      FROM public.central_needs_beneficiary_column_mappings m
     WHERE m.import_session_id = v_session.id
       AND m.sheet_index       = v_sheet
       AND m.column_index      = (v_n->>'columnIndex')::integer
       FOR UPDATE;
    IF NOT FOUND
       OR v_mapping.id <> (v_n->>'expectedMappingId')::uuid
       OR v_mapping.decision IS DISTINCT FROM (v_n->>'previousDecision')
       OR v_mapping.beneficiary_organization_id IS DISTINCT FROM (v_n->>'previousBeneficiaryOrganizationId')::uuid
       OR v_mapping.mapped_at IS DISTINCT FROM (v_n->>'previousMappedAt')::timestamptz THEN
      RAISE EXCEPTION 'beneficiary_region_stale' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s m213_decision_changed', v_session.id, v_sheet, v_n->>'columnIndex'),
        HINT = 'This column''s M213 decision changed since you loaded it. Reload and decide again; nothing was written.';
    END IF;
  END LOOP;

  -- ---- 12. every per-item validation, still before any write ---------------
  FOR v_n IN SELECT e FROM jsonb_array_elements(v_items) AS e
  LOOP
    v_op := v_n->>'op';
    IF v_op IN ('add', 'replace') THEN
      -- 12a bounds (0-based, inclusive, Excel ceilings)
      IF (v_n->>'rowStart')::numeric < 0
         OR (v_n->>'rowStart')::numeric > (v_n->>'rowEnd')::numeric
         OR (v_n->>'rowEnd')::numeric > 1048575
         OR (v_n->>'columnStart')::numeric < 0
         OR (v_n->>'columnStart')::numeric > (v_n->>'columnEnd')::numeric
         OR (v_n->>'columnEnd')::numeric > 16383 THEN
        RAISE EXCEPTION 'beneficiary_region_bounds_invalid' USING ERRCODE = '23514',
          DETAIL = format('item=%s bounds=[%s..%s]x[%s..%s]', v_n->>'ord',
                          v_n->>'rowStart', v_n->>'rowEnd', v_n->>'columnStart', v_n->>'columnEnd');
      END IF;
      v_rs := (v_n->>'rowStart')::integer;
      v_re := (v_n->>'rowEnd')::integer;
      v_cs := (v_n->>'columnStart')::integer;
      v_ce := (v_n->>'columnEnd')::integer;
      -- 12b explicit decision; there is no default
      IF jsonb_typeof(v_n->'decision') IS DISTINCT FROM 'string'
         OR (v_n->>'decision') NOT IN ('beneficiary', 'non_beneficiary') THEN
        RAISE EXCEPTION 'beneficiary_region_decision_invalid' USING ERRCODE = '23514',
          DETAIL = format('item=%s decision=%s', v_n->>'ord', coalesce(v_n->>'decision', '(none)'));
      END IF;
      v_decision := v_n->>'decision';
      v_ben := (v_n->>'beneficiaryOrganizationId')::uuid;
      -- 12c decision/beneficiary shape
      IF v_decision = 'beneficiary' AND v_ben IS NULL THEN
        RAISE EXCEPTION 'beneficiary_region_beneficiary_required' USING ERRCODE = '23514',
          DETAIL = format('item=%s', v_n->>'ord');
      END IF;
      IF v_decision = 'non_beneficiary' AND v_ben IS NOT NULL THEN
        RAISE EXCEPTION 'beneficiary_region_non_beneficiary_must_not_name_beneficiary' USING ERRCODE = '23514',
          DETAIL = format('item=%s beneficiary=%s', v_n->>'ord', v_ben);
      END IF;
      -- 12d the single M212 eligibility definition, with no warehouse
      IF v_decision = 'beneficiary' THEN
        PERFORM public._phoenix_central_needs_assert_beneficiary_v1(v_ben, NULL);
      END IF;
    END IF;

    IF v_op IN ('replace', 'remove') THEN
      -- 12e the target is an ACTIVE version of the fenced set
      v_vid := (v_n->>'versionId')::uuid;
      IF NOT (v_vid = ANY (v_active)) THEN
        RAISE EXCEPTION 'beneficiary_region_unknown' USING ERRCODE = '23514',
          DETAIL = format('item=%s version=%s is not an ACTIVE version of session=%s sheet=%s',
                          v_n->>'ord', v_vid, v_session.id, v_sheet);
      END IF;
      SELECT * INTO v_target FROM public.central_needs_beneficiary_regions WHERE version_id = v_vid;
      v_targets := v_targets || v_vid;
      v_n := v_n || jsonb_build_object(
        'targetRegionId', v_target.region_id,
        'targetVersionNo', v_target.version_no,
        'targetRowStart', v_target.row_start, 'targetRowEnd', v_target.row_end,
        'targetColumnStart', v_target.column_start, 'targetColumnEnd', v_target.column_end,
        'targetDecision', v_target.decision,
        'targetBeneficiaryOrganizationId', v_target.beneficiary_organization_id);
    END IF;

    IF v_op IN ('add', 'replace') THEN
      -- 12f evidence: at least one persisted record, any valueType, inside
      IF NOT EXISTS (
        SELECT 1 FROM public.central_needs_source_records r
         WHERE r.import_session_id = v_session.id
           AND public._phoenix_central_needs_safe_coordinate_v1(r.source_provenance->'sheetIndex', 2147483647) = v_sheet
           AND public._phoenix_central_needs_safe_coordinate_v1(r.source_provenance->'coordinate'->'row', 1048575) BETWEEN v_rs AND v_re
           AND public._phoenix_central_needs_safe_coordinate_v1(r.source_provenance->'coordinate'->'col', 16383) BETWEEN v_cs AND v_ce
      ) THEN
        RAISE EXCEPTION 'beneficiary_region_no_matching_evidence' USING ERRCODE = '23503',
          DETAIL = format('item=%s session=%s sheet=%s bounds=[%s..%s]x[%s..%s]',
                          v_n->>'ord', v_session.id, v_sheet, v_rs, v_re, v_cs, v_ce),
          HINT = 'No authoritative source record lies inside this rectangle.';
      END IF;
    END IF;

    v_plan := v_plan || jsonb_build_array(v_n);
  END LOOP;

  -- 12g duplicates, no-ops and the repetition rule (each rectangle appears in
  --     at most one operation, except one same-bounds replace).
  FOR v_n IN SELECT e FROM jsonb_array_elements(v_plan) AS e
  LOOP
    v_op := v_n->>'op';
    v_new_key := NULL;
    v_old_key := NULL;
    IF v_op IN ('add', 'replace') THEN
      v_new_key := format('%s,%s,%s,%s', v_n->>'rowStart', v_n->>'rowEnd', v_n->>'columnStart', v_n->>'columnEnd');
    END IF;
    IF v_op IN ('replace', 'remove') THEN
      v_old_key := format('%s,%s,%s,%s', v_n->>'targetRowStart', v_n->>'targetRowEnd',
                          v_n->>'targetColumnStart', v_n->>'targetColumnEnd');
    END IF;

    -- (ii) a replace to identical content is a no-op
    IF v_op = 'replace' AND v_new_key = v_old_key
       AND (v_n->>'decision') = (v_n->>'targetDecision')
       AND (v_n->>'beneficiaryOrganizationId')::uuid IS NOT DISTINCT FROM (v_n->>'targetBeneficiaryOrganizationId')::uuid THEN
      RAISE EXCEPTION 'beneficiary_region_duplicate' USING ERRCODE = '23514',
        DETAIL = format('item=%s replace_to_identical_content version=%s', v_n->>'ord', v_n->>'versionId');
    END IF;

    -- (i) an inserted rectangle equal to an ACTIVE version the call keeps
    IF v_new_key IS NOT NULL THEN
      SELECT v.version_id INTO v_bad
        FROM public.central_needs_beneficiary_regions v
       WHERE v.version_id = ANY (v_active)
         AND NOT (v.version_id = ANY (v_targets))
         AND v.row_start = (v_n->>'rowStart')::integer AND v.row_end = (v_n->>'rowEnd')::integer
         AND v.column_start = (v_n->>'columnStart')::integer AND v.column_end = (v_n->>'columnEnd')::integer
       LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'beneficiary_region_duplicate' USING ERRCODE = '23514',
          DETAIL = format('item=%s bounds=%s equal_active_version=%s', v_n->>'ord', v_new_key, v_bad.version_id),
          HINT = 'These exact bounds are already an ACTIVE region. Change its decision or beneficiary with an explicit replace.';
      END IF;
    END IF;

    -- (iii) the appearances of every rectangle in this call
    IF v_op = 'replace' AND v_new_key = v_old_key THEN
      v_appear := v_appear || v_new_key;
    ELSE
      IF v_old_key IS NOT NULL THEN v_appear := v_appear || v_old_key; END IF;
      IF v_new_key IS NOT NULL THEN v_appear := v_appear || v_new_key; END IF;
    END IF;
  END LOOP;

  SELECT k INTO v_bad FROM unnest(v_appear) AS k GROUP BY k HAVING count(*) > 1 ORDER BY k LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'beneficiary_region_duplicate' USING ERRCODE = '23514',
      DETAIL = format('bounds=%s appear_in_more_than_one_operation', v_bad.k),
      HINT = 'Each rectangle may appear in one operation per call. Change a decision on the same bounds with one explicit replace.';
  END IF;

  -- 12h a conversion needs an explicit new region over its column
  FOREACH v_col IN ARRAY v_conv_cols LOOP
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_plan) AS e
       WHERE e->>'op' IN ('add', 'replace')
         AND (e->>'columnStart')::integer <= v_col
         AND (e->>'columnEnd')::integer   >= v_col
    ) THEN
      RAISE EXCEPTION 'beneficiary_region_conversion_requires_region' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s', v_session.id, v_sheet, v_col),
        HINT = 'Converting a column to regions needs at least one new region, drawn and decided by you, over that column. Nothing is copied from the M213 decision.';
    END IF;
  END LOOP;

  -- ======================== FIRST WRITE BELOW ================================

  -- ---- 13. M213 conversions: the fenced, governed delete -------------------
  FOR v_n IN SELECT e FROM jsonb_array_elements(v_plan) AS e WHERE e->>'op' = 'convert_column'
  LOOP
    DELETE FROM public.central_needs_beneficiary_column_mappings
     WHERE id = (v_n->>'expectedMappingId')::uuid
    RETURNING * INTO v_mapping;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'beneficiary_region_stale' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s m213_row_vanished', v_session.id, v_sheet, v_n->>'columnIndex');
    END IF;
    v_snapshots := v_snapshots || jsonb_build_object(v_n->>'columnIndex', jsonb_build_object(
      'id', v_mapping.id,
      'decision', v_mapping.decision,
      'beneficiary_organization_id', v_mapping.beneficiary_organization_id,
      'source_field_name', v_mapping.source_field_name,
      'mapping_reason', v_mapping.mapping_reason,
      'mapped_by', v_mapping.mapped_by,
      'mapped_at', v_mapping.mapped_at));
  END LOOP;

  -- ---- 14. retirement stamps: every stamp precedes every insert ------------
  FOR v_n IN SELECT e FROM jsonb_array_elements(v_plan) AS e WHERE e->>'op' IN ('replace', 'remove')
  LOOP
    UPDATE public.central_needs_beneficiary_regions
       SET retired_at        = v_now,
           retired_by        = v_actor,
           retirement_kind   = CASE WHEN v_n->>'op' = 'replace' THEN 'replaced' ELSE 'removed' END,
           retirement_reason = v_reason
     WHERE version_id = (v_n->>'versionId')::uuid
       AND retired_at IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'beneficiary_region_stale' USING ERRCODE = '23514',
        DETAIL = format('version=%s is no longer ACTIVE', v_n->>'versionId');
    END IF;
  END LOOP;

  -- ---- 15. new version inserts ------------------------------------------------
  FOR v_n IN SELECT e FROM jsonb_array_elements(v_plan) AS e WHERE e->>'op' IN ('add', 'replace')
  LOOP
    BEGIN
      INSERT INTO public.central_needs_beneficiary_regions (
        region_id, version_no, supersedes_version_id,
        plan_revision_id, organization_id, import_session_id, sheet_index,
        row_start, row_end, column_start, column_end,
        decision, beneficiary_organization_id,
        decision_reason, decided_by, decided_at
      ) VALUES (
        CASE WHEN v_n->>'op' = 'add' THEN gen_random_uuid() ELSE (v_n->>'targetRegionId')::uuid END,
        CASE WHEN v_n->>'op' = 'add' THEN 1 ELSE (v_n->>'targetVersionNo')::integer + 1 END,
        CASE WHEN v_n->>'op' = 'add' THEN NULL ELSE (v_n->>'versionId')::uuid END,
        v_revision.id, v_revision.organization_id, v_session.id, v_sheet,
        (v_n->>'rowStart')::integer, (v_n->>'rowEnd')::integer,
        (v_n->>'columnStart')::integer, (v_n->>'columnEnd')::integer,
        v_n->>'decision', (v_n->>'beneficiaryOrganizationId')::uuid,
        v_reason, v_actor, v_now
      )
      RETURNING version_id, region_id INTO v_new_id, v_region_id;
    EXCEPTION WHEN unique_violation THEN
      -- Backstop only: step 12 makes these unreachable on this path.
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint IN ('central_needs_beneficiary_regions_active_geometry_uidx',
                          'central_needs_beneficiary_regions_active_region_uidx',
                          'central_needs_beneficiary_regions_region_version_key',
                          'central_needs_beneficiary_regions_supersedes_key') THEN
        RAISE EXCEPTION 'beneficiary_region_duplicate' USING ERRCODE = '23514',
          DETAIL = format('item=%s backstop=%s', v_n->>'ord', v_constraint);
      END IF;
      RAISE;
    END;
    v_new_ids := v_new_ids || jsonb_build_object(v_n->>'ord', jsonb_build_object(
      'versionId', v_new_id, 'regionId', v_region_id));
  END LOOP;

  -- ---- 16. final-state checks over the scope's ACTIVE versions --------------
  SELECT a.version_id AS a_id, b.version_id AS b_id INTO v_bad
    FROM public.central_needs_beneficiary_regions a
    JOIN public.central_needs_beneficiary_regions b
      ON b.import_session_id = a.import_session_id
     AND b.sheet_index       = a.sheet_index
     AND b.retired_at IS NULL
     AND a.version_id < b.version_id
     AND a.row_start <= b.row_end AND b.row_start <= a.row_end
     AND a.column_start <= b.column_end AND b.column_start <= a.column_end
   WHERE a.retired_at IS NULL
     AND a.import_session_id = v_session.id
     AND a.sheet_index       = v_sheet
   ORDER BY a.version_id, b.version_id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'beneficiary_region_overlap' USING ERRCODE = '23514',
      DETAIL = format('session=%s sheet=%s region=%s other_region=%s', v_session.id, v_sheet, v_bad.a_id, v_bad.b_id),
      HINT = 'Regions of one sheet may touch but never share a cell, whatever their beneficiary or decision.';
  END IF;

  SELECT v.version_id, m.column_index INTO v_bad
    FROM public.central_needs_beneficiary_regions v
    JOIN public.central_needs_beneficiary_column_mappings m
      ON m.import_session_id = v.import_session_id
     AND m.sheet_index       = v.sheet_index
     AND m.column_index BETWEEN v.column_start AND v.column_end
   WHERE v.retired_at IS NULL
     AND v.import_session_id = v_session.id
     AND v.sheet_index       = v_sheet
   ORDER BY m.column_index, v.version_id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'beneficiary_region_column_already_decided' USING ERRCODE = '23514',
      DETAIL = format('session=%s sheet=%s column=%s region=%s', v_session.id, v_sheet, v_bad.column_index, v_bad.version_id),
      HINT = 'This column already has a whole-column M213 decision. Convert it to regions explicitly in the same call, or keep it in M213.';
  END IF;

  FOREACH v_col IN ARRAY v_conv_cols LOOP
    IF EXISTS (
      SELECT 1 FROM public.central_needs_beneficiary_column_mappings m
       WHERE m.import_session_id = v_session.id AND m.sheet_index = v_sheet AND m.column_index = v_col
    ) THEN
      RAISE EXCEPTION 'beneficiary_region_column_already_decided' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s converted_column_still_has_m213_row', v_session.id, v_sheet, v_col);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.central_needs_beneficiary_regions v
       WHERE v.retired_at IS NULL
         AND v.import_session_id = v_session.id AND v.sheet_index = v_sheet
         AND v_col BETWEEN v.column_start AND v.column_end
    ) THEN
      RAISE EXCEPTION 'beneficiary_region_conversion_requires_region' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s converted_column_has_no_active_region', v_session.id, v_sheet, v_col);
    END IF;
  END LOOP;

  SELECT * INTO v_bad
    FROM public._phoenix_central_needs_region_linked_cell_violations_v1(v_session.id, v_sheet)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'beneficiary_region_in_use' USING ERRCODE = '23514',
      DETAIL = format('session=%s sheet=%s source_record=%s need_line=%s line_beneficiary=%s failure=%s',
                      v_session.id, v_sheet, v_bad.source_record_id, v_bad.need_line_id,
                      v_bad.line_beneficiary, v_bad.failure),
      HINT = 'A cell already feeding a need line would lose or switch its beneficiary region. Delete that line with a reason (delete_need_line) first, then re-designate the cells after this change. Nothing was written.';
  END IF;

  -- ---- 17. audit: one row per converted column, one per region change -----
  FOR v_n IN SELECT e FROM jsonb_array_elements(v_plan) AS e WHERE e->>'op' = 'convert_column'
  LOOP
    v_col := (v_n->>'columnIndex')::integer;
    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role, action, entity_type, entity_id,
      entity_label, payload
    ) VALUES (
      v_revision.organization_id, v_actor, v_actor_role,
      'central_needs.beneficiary_column.converted_to_regions', 'central_needs_beneficiary_column_mapping',
      (v_snapshots->(v_col::text)->>'id')::uuid,
      NULL,
      jsonb_build_object(
        'plan_revision_id', v_revision.id,
        'import_session_id', v_session.id,
        'sheet_index', v_sheet,
        'column_index', v_col,
        'operation_batch_id', v_batch_id,
        'retired_mapping', v_snapshots->(v_col::text),
        'reason', v_reason,
        'new_version_ids', (
          SELECT coalesce(jsonb_agg(v_new_ids->(e->>'ord')->'versionId' ORDER BY (e->>'ord')::integer), '[]'::jsonb)
            FROM jsonb_array_elements(v_plan) AS e
           WHERE e->>'op' IN ('add', 'replace')
             AND (e->>'columnStart')::integer <= v_col
             AND (e->>'columnEnd')::integer   >= v_col)
      )
    );
    v_converted := v_converted || jsonb_build_array(jsonb_build_object(
      'columnIndex', v_col, 'retiredMappingId', v_snapshots->(v_col::text)->'id'));
  END LOOP;

  FOR v_n IN SELECT e FROM jsonb_array_elements(v_plan) AS e WHERE e->>'op' IN ('add', 'replace', 'remove')
  LOOP
    v_op := v_n->>'op';
    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role, action, entity_type, entity_id,
      entity_label, payload
    ) VALUES (
      v_revision.organization_id, v_actor, v_actor_role,
      'central_needs.beneficiary_region.' || v_op, 'central_needs_beneficiary_region',
      CASE WHEN v_op = 'add' THEN (v_new_ids->(v_n->>'ord')->>'regionId')::uuid
           ELSE (v_n->>'targetRegionId')::uuid END,
      NULL,
      jsonb_build_object(
        'plan_revision_id', v_revision.id,
        'import_session_id', v_session.id,
        'sheet_index', v_sheet,
        'operation_batch_id', v_batch_id,
        'expected_version_ids', to_jsonb(v_expected),
        'region_id', CASE WHEN v_op = 'add' THEN v_new_ids->(v_n->>'ord')->'regionId'
                          ELSE v_n->'targetRegionId' END,
        'previous_version_id', CASE WHEN v_op = 'add' THEN NULL ELSE v_n->'versionId' END,
        'new_version_id', CASE WHEN v_op = 'remove' THEN NULL ELSE v_new_ids->(v_n->>'ord')->'versionId' END,
        'previous_bounds', CASE WHEN v_op = 'add' THEN NULL ELSE jsonb_build_object(
            'rowStart', v_n->'targetRowStart', 'rowEnd', v_n->'targetRowEnd',
            'columnStart', v_n->'targetColumnStart', 'columnEnd', v_n->'targetColumnEnd') END,
        'previous_decision', CASE WHEN v_op = 'add' THEN NULL ELSE v_n->'targetDecision' END,
        'previous_beneficiary_organization_id', CASE WHEN v_op = 'add' THEN NULL ELSE v_n->'targetBeneficiaryOrganizationId' END,
        'new_bounds', CASE WHEN v_op = 'remove' THEN NULL ELSE jsonb_build_object(
            'rowStart', (v_n->>'rowStart')::integer, 'rowEnd', (v_n->>'rowEnd')::integer,
            'columnStart', (v_n->>'columnStart')::integer, 'columnEnd', (v_n->>'columnEnd')::integer) END,
        'new_decision', CASE WHEN v_op = 'remove' THEN NULL ELSE v_n->'decision' END,
        'new_beneficiary_organization_id', CASE WHEN v_op = 'remove' THEN NULL ELSE v_n->'beneficiaryOrganizationId' END,
        'reason', v_reason
      )
    );
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'op', v_op,
      'regionId', CASE WHEN v_op = 'add' THEN v_new_ids->(v_n->>'ord')->'regionId' ELSE v_n->'targetRegionId' END,
      'previousVersionId', CASE WHEN v_op = 'add' THEN NULL ELSE v_n->'versionId' END,
      'newVersionId', CASE WHEN v_op = 'remove' THEN NULL ELSE v_new_ids->(v_n->>'ord')->'versionId' END));
  END LOOP;

  -- ---- 18. return: the complete final ACTIVE set is the next fence ---------
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'version_id', v.version_id,
           'region_id', v.region_id,
           'version_no', v.version_no,
           'supersedes_version_id', v.supersedes_version_id,
           'row_start', v.row_start, 'row_end', v.row_end,
           'column_start', v.column_start, 'column_end', v.column_end,
           'decision', v.decision,
           'beneficiary_organization_id', v.beneficiary_organization_id,
           'decision_reason', v.decision_reason,
           'decided_by', v.decided_by,
           'decided_at', v.decided_at
         ) ORDER BY v.row_start, v.column_start, v.version_id), '[]'::jsonb)
    INTO v_active_out
    FROM public.central_needs_beneficiary_regions v
   WHERE v.import_session_id = v_session.id
     AND v.sheet_index       = v_sheet
     AND v.retired_at IS NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'plan_revision_id', v_revision.id,
    'import_session_id', v_session.id,
    'sheet_index', v_sheet,
    'operation_batch_id', v_batch_id,
    'active_versions', v_active_out,
    'changes', v_changes,
    'converted_columns', v_converted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_set_beneficiary_regions(
  uuid, uuid, numeric, jsonb, text, uuid[], jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_set_beneficiary_regions(
  uuid, uuid, numeric, jsonb, text, uuid[], jsonb, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_set_beneficiary_regions(
  uuid, uuid, numeric, jsonb, text, uuid[], jsonb, text) IS
  'C4 (216): the ONE write path of beneficiary regions. Atomically applies add / replace / remove / convert_column over one (import session, sheet) of a DRAFT revision: revision FOR UPDATE, guard, org live, draft, newest revision, mandatory reason, shape, session, refuse-only parser-identity and sheet-name witnesses, the exact ACTIVE version-id fence and exact null-safe M213 fence, full validation, then M213 conversions, retirement stamps, inserts, final-state checks (overlap, X1, converted columns, linked cells) and one audit row per change. Any refusal writes nothing and no audit.';

-- ----------------------------------------------------------------------------
-- 10. Behaviour-only replacement of _phoenix_central_needs_review_blockers_v1:
--     branches 1-12 reproduced verbatim from M213; branch 13 changed ONLY by
--     one per-cell exclusion; branches 14-18 appended, over ACTIVE versions.
--     The public review_readiness wrapper and submit are unchanged.
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
         -- 216: the ONE change to this branch — a per-cell exclusion. A cell
         -- leaves it only when the safe extractor (the one blocker 14 uses)
         -- locates its sheet and column AND that column is region-governed;
         -- blocker 14 then owns the cell. A cell whose coordinates cannot be
         -- safely extracted is never excluded.
         AND NOT (SELECT g.column_governed
                    FROM public._phoenix_central_needs_resolve_region_v1(r.import_session_id, r.source_provenance) AS g)
       GROUP BY r.import_session_id,
                (r.source_provenance->>'sheetIndex')::integer,
                (r.source_provenance->'coordinate'->>'col')::integer
    ) c
   WHERE NOT EXISTS (
     SELECT 1 FROM public.central_needs_beneficiary_column_mappings cm
      WHERE cm.import_session_id = c.import_session_id
        AND cm.sheet_index       = c.sheet_index
        AND cm.column_index      = c.column_index
   )

  UNION ALL
  -- 216 (14). The cell-grain twin of branch 13 for region-governed columns: a
  --      numeric cell on a mapped row of a completed session whose safely
  --      extracted sheet and column lie in a column an ACTIVE region spans,
  --      but which no ACTIVE region covers (or whose row cannot be located).
  --      Exactly the cells branch 13's exclusion removes. Aggregated per
  --      (session, sheet, column), like branch 13.
  SELECT 'beneficiary_region_cell_uncovered',
         format('session=%s sheet=%s column=%s uncovered_numeric_cells_on_mapped_rows=%s first_uncovered_row=%s',
                u.import_session_id, u.sheet_index, u.column_index, u.cells,
                coalesce(u.first_row::text, '(unidentified)'))
    FROM (
      SELECT r.import_session_id, g.cell_sheet AS sheet_index, g.cell_col AS column_index,
             count(*) AS cells, min(g.cell_row) AS first_row
        FROM public.central_needs_source_records r
        JOIN public.central_needs_import_sessions s ON s.id = r.import_session_id
        JOIN public.central_needs_record_mappings rm
          ON rm.import_session_id = r.import_session_id
         AND rm.target_entity     = r.target_entity
         AND rm.decision          = 'mapped'
        CROSS JOIN LATERAL public._phoenix_central_needs_resolve_region_v1(r.import_session_id, r.source_provenance) g
       WHERE s.plan_revision_id = p_plan_revision_id
         AND s.status = 'completed'
         AND r.source_values->>'valueType' = 'number'
         AND g.column_governed
         AND g.covering_count = 0
       GROUP BY r.import_session_id, g.cell_sheet, g.cell_col
    ) u

  UNION ALL
  -- 216 (15). The region twin of branch 12: a numeric cell on a mapped row of
  --      a completed session, covered by an ACTIVE 'beneficiary' region, that
  --      no need line links. A non_beneficiary region's cells are reviewed,
  --      never linked.
  SELECT 'beneficiary_region_cell_without_need_line',
         format('session=%s sheet=%s row=%s column=%s region=%s target_entity=%s source_record=%s',
                r.import_session_id, v.sheet_index, g.cell_row, g.cell_col, v.version_id,
                r.target_entity, r.id)
    FROM public.central_needs_source_records r
    JOIN public.central_needs_import_sessions s ON s.id = r.import_session_id
    JOIN public.central_needs_record_mappings rm
      ON rm.import_session_id = r.import_session_id
     AND rm.target_entity     = r.target_entity
     AND rm.decision          = 'mapped'
    CROSS JOIN LATERAL public._phoenix_central_needs_resolve_region_v1(r.import_session_id, r.source_provenance) g
    JOIN public.central_needs_beneficiary_regions v
      ON v.retired_at IS NULL
     AND v.import_session_id = r.import_session_id
     AND v.sheet_index       = g.cell_sheet
     AND g.cell_row BETWEEN v.row_start AND v.row_end
     AND g.cell_col BETWEEN v.column_start AND v.column_end
     AND v.decision = 'beneficiary'
   WHERE s.plan_revision_id = p_plan_revision_id
     AND s.status = 'completed'
     AND r.source_values->>'valueType' = 'number'
     AND NOT EXISTS (
       SELECT 1 FROM public.central_needs_need_line_sources ls
        WHERE ls.source_record_id = r.id
     )

  UNION ALL
  -- 216 (16). Defence: two ACTIVE regions of one (session, sheet) intersect.
  SELECT 'beneficiary_region_overlap',
         format('session=%s sheet=%s region=%s other_region=%s',
                a.import_session_id, a.sheet_index, a.version_id, b.version_id)
    FROM public.central_needs_beneficiary_regions a
    JOIN public.central_needs_beneficiary_regions b
      ON b.import_session_id = a.import_session_id
     AND b.sheet_index       = a.sheet_index
     AND b.retired_at IS NULL
     AND a.version_id < b.version_id
     AND a.row_start <= b.row_end AND b.row_start <= a.row_end
     AND a.column_start <= b.column_end AND b.column_start <= a.column_end
   WHERE a.plan_revision_id = p_plan_revision_id
     AND a.retired_at IS NULL

  UNION ALL
  -- 216 (17). Defence: a column with an M213 row is spanned by an ACTIVE
  --      region (X1 violated).
  SELECT 'beneficiary_decision_grain_conflict',
         format('session=%s sheet=%s column=%s mapping=%s region=%s',
                m.import_session_id, m.sheet_index, m.column_index, m.id, v.version_id)
    FROM public.central_needs_beneficiary_column_mappings m
    JOIN public.central_needs_beneficiary_regions v
      ON v.retired_at IS NULL
     AND v.import_session_id = m.import_session_id
     AND v.sheet_index       = m.sheet_index
     AND m.column_index BETWEEN v.column_start AND v.column_end
   WHERE m.plan_revision_id = p_plan_revision_id

  UNION ALL
  -- 216 (18). Defence for stale or invalid geometry of an ACTIVE region: its
  --      session is not completed, its bounds break the frame, or no
  --      persisted record with safely extractable coordinates lies inside.
  SELECT 'beneficiary_region_geometry_invalid',
         format('session=%s sheet=%s region=%s reason=%s',
                v.import_session_id, v.sheet_index, v.version_id, x.reason)
    FROM public.central_needs_beneficiary_regions v
    JOIN public.central_needs_import_sessions s ON s.id = v.import_session_id
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN s.status IS DISTINCT FROM 'completed' THEN 'session_not_completed'
               WHEN NOT (v.sheet_index >= 0
                         AND v.row_start >= 0 AND v.row_start <= v.row_end AND v.row_end <= 1048575
                         AND v.column_start >= 0 AND v.column_start <= v.column_end AND v.column_end <= 16383)
                 THEN 'bounds_invalid'
               WHEN NOT EXISTS (
                 SELECT 1 FROM public.central_needs_source_records r
                  WHERE r.import_session_id = v.import_session_id
                    AND public._phoenix_central_needs_safe_coordinate_v1(r.source_provenance->'sheetIndex', 2147483647) = v.sheet_index
                    AND public._phoenix_central_needs_safe_coordinate_v1(r.source_provenance->'coordinate'->'row', 1048575)
                          BETWEEN v.row_start AND v.row_end
                    AND public._phoenix_central_needs_safe_coordinate_v1(r.source_provenance->'coordinate'->'col', 16383)
                          BETWEEN v.column_start AND v.column_end)
                 THEN 'no_matching_evidence'
             END AS reason
    ) x
   WHERE v.plan_revision_id = p_plan_revision_id
     AND v.retired_at IS NULL
     AND x.reason IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid) IS
  'CN-2B internal: the single definition of review completeness. M211''s five branches, M212''s nine and M213''s beneficiary_column_cell_without_need_line reproduced verbatim; M213''s beneficiary_column_review_required narrowed ONLY by a per-cell exclusion of cells the safe extractor places in a region-governed column (216); and five 216 branches over ACTIVE region versions: beneficiary_region_cell_uncovered, beneficiary_region_cell_without_need_line, beneficiary_region_overlap, beneficiary_decision_grain_conflict and beneficiary_region_geometry_invalid.';

-- ----------------------------------------------------------------------------
-- 11. Behaviour-only replacement of phoenix_central_needs_list_beneficiary_columns:
--     same signature, same 17 columns, still SECURITY INVOKER; review_required
--     narrowed exactly as blocker branch 13.
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
    -- 216: narrowed exactly as blocker branch 13 — per cell, a cell whose
    -- safely extracted column is region-governed (an ACTIVE region spans it)
    -- is not counted. The extractor is inlined because an internal helper is
    -- never executable by the invoking client: a JSON number of plain
    -- decimal digits, and a column at most 16383.
    (m.id IS NULL
     AND count(*) FILTER (WHERE r.source_values->>'valueType' = 'number'
                            AND rm.decision = 'mapped' AND s.status = 'completed'
                            AND NOT EXISTS (
                              SELECT 1 FROM public.central_needs_beneficiary_regions v
                               WHERE v.retired_at IS NULL
                                 AND v.import_session_id = r.import_session_id
                                 AND v.sheet_index = CASE
                                       WHEN jsonb_typeof(r.source_provenance->'sheetIndex') = 'number'
                                        AND (r.source_provenance->>'sheetIndex') ~ '^[0-9]{1,9}$'
                                       THEN (r.source_provenance->>'sheetIndex')::integer END
                                 AND CASE
                                       WHEN jsonb_typeof(r.source_provenance->'coordinate'->'col') = 'number'
                                        AND (r.source_provenance->'coordinate'->>'col') ~ '^[0-9]{1,9}$'
                                       THEN CASE WHEN (r.source_provenance->'coordinate'->>'col')::integer <= 16383
                                                 THEN (r.source_provenance->'coordinate'->>'col')::integer END
                                     END BETWEEN v.column_start AND v.column_end)) > 0) AS review_required
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
  'CN-2B corrective extension (213, narrowed by 216): the bounded, revision-level summary of every physical candidate beneficiary column — one row per (import_session_id, sheet_index, column_index), never one row per cell. SECURITY INVOKER: the caller''s own RLS decides visibility. Each row also carries the column''s explicit review decision (column_decision) and review_required — true exactly when the column has no decision yet but carries numeric evidence on a mapped row in a completed session outside any region-governed column, the same rule the beneficiary_column_review_required blocker enforces.';

-- ----------------------------------------------------------------------------
-- 12. VERIFY — fail the migration rather than ship a half-applied contract.
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  n        integer;
  v_sig    text;
  v_def    text;
  v_code   text;
  v_internal text[] := ARRAY[
    'public._phoenix_central_needs_safe_coordinate_v1(jsonb, integer)',
    'public._phoenix_central_needs_m213_coordinate_v1(text)',
    'public._phoenix_central_needs_resolve_region_v1(uuid, jsonb)',
    'public._phoenix_central_needs_region_linked_cell_violations_v1(uuid, integer)',
    'public._phoenix_central_needs_region_column_covered_v1(uuid, integer, integer)',
    'public._phoenix_central_needs_region_version_guard_v1()',
    'public._phoenix_central_needs_assert_region_geometry_v1()',
    'public._phoenix_central_needs_assert_need_line_integrity_v1()',
    'public._phoenix_central_needs_review_blockers_v1(uuid)'
  ];
  v_rpc text := 'public.phoenix_central_needs_set_beneficiary_regions(uuid, uuid, numeric, jsonb, text, uuid[], jsonb, text)';
  v_set_line text := 'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)';
  v_list text := 'public.phoenix_central_needs_list_beneficiary_columns(uuid)';
BEGIN
  -- The relation: RLS enabled and forced, no client or anon write.
  IF to_regclass('public.central_needs_beneficiary_regions') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): central_needs_beneficiary_regions missing';
  END IF;
  SELECT count(*) INTO n FROM pg_class
   WHERE oid = 'public.central_needs_beneficiary_regions'::regclass
     AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): RLS not ENABLED+FORCED on the region relation';
  END IF;
  IF has_table_privilege('authenticated', 'public.central_needs_beneficiary_regions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.central_needs_beneficiary_regions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.central_needs_beneficiary_regions', 'DELETE')
     OR has_table_privilege('authenticated', 'public.central_needs_beneficiary_regions', 'TRUNCATE')
     OR NOT has_table_privilege('authenticated', 'public.central_needs_beneficiary_regions', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): authenticated must hold SELECT only on the region relation';
  END IF;
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee IN ('anon', 'PUBLIC') AND table_schema = 'public'
     AND table_name = 'central_needs_beneficiary_regions';
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): anon/PUBLIC hold % grant(s) on the region relation', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policy
   WHERE polrelid = 'public.central_needs_beneficiary_regions'::regclass
     AND NOT polpermissive
     AND pg_get_expr(polqual, polrelid) LIKE '%_phoenix_central_needs_role_eligible_v1()%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): restrictive role-class policy missing on the region relation';
  END IF;
  SELECT count(*) INTO n FROM pg_policy
   WHERE polrelid = 'public.central_needs_beneficiary_regions'::regclass
     AND polpermissive AND polcmd = 'r'
     AND pg_get_expr(polqual, polrelid) LIKE '%central_needs.view%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): central_needs.view select policy missing on the region relation';
  END IF;

  -- S12 and S13 exist as partial uniqueness over ACTIVE versions; no plain
  -- geometry uniqueness exists.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = 'public.central_needs_beneficiary_regions_active_region_uidx'::regclass
       AND i.indisunique
       AND pg_get_expr(i.indpred, i.indrelid) = '(retired_at IS NULL)'
       AND pg_get_indexdef(i.indexrelid) LIKE '%(region_id)%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = 'public.central_needs_beneficiary_regions_active_geometry_uidx'::regclass
       AND i.indisunique
       AND pg_get_expr(i.indpred, i.indrelid) = '(retired_at IS NULL)'
       AND pg_get_indexdef(i.indexrelid) LIKE '%(import_session_id, sheet_index, row_start, row_end, column_start, column_end)%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): a partial ACTIVE uniqueness rule (S12/S13) is missing';
  END IF;
  SELECT count(*) INTO n FROM pg_index i
   WHERE i.indrelid = 'public.central_needs_beneficiary_regions'::regclass
     AND i.indisunique
     AND i.indpred IS NULL
     AND pg_get_indexdef(i.indexrelid) LIKE '%row_start%';
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): a plain (non-partial) geometry uniqueness exists';
  END IF;

  -- T1-T4.
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE t.tgrelid = 'public.central_needs_beneficiary_regions'::regclass
     AND t.tgname = 'central_needs_beneficiary_regions_guard'
     AND NOT t.tgisinternal AND t.tgconstraint = 0
     AND t.tgfoid = 'public._phoenix_central_needs_region_version_guard_v1()'::regprocedure;
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): T1 missing';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE t.tgrelid = 'public.central_needs_beneficiary_regions'::regclass
     AND t.tgname = 'assert_need_line_integrity'
     AND NOT t.tgisinternal AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
     AND t.tgfoid = 'public._phoenix_central_needs_assert_need_line_integrity_v1()'::regprocedure;
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): T2 missing';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE t.tgrelid = 'public.central_needs_beneficiary_regions'::regclass
     AND t.tgname = 'assert_beneficiary_region_geometry'
     AND NOT t.tgisinternal AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
     AND t.tgfoid = 'public._phoenix_central_needs_assert_region_geometry_v1()'::regprocedure;
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): T3 missing';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE t.tgrelid = 'public.central_needs_beneficiary_column_mappings'::regclass
     AND t.tgname = 'assert_beneficiary_region_grain'
     AND NOT t.tgisinternal AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
     AND t.tgfoid = 'public._phoenix_central_needs_assert_region_geometry_v1()'::regprocedure;
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): T4 missing';
  END IF;

  -- The M213 table: columns, constraints, indexes and policies unchanged;
  -- exactly one new trigger (T4).
  IF (SELECT array_agg(tgname::text ORDER BY tgname) FROM pg_trigger
       WHERE tgrelid = 'public.central_needs_beneficiary_column_mappings'::regclass
         AND NOT tgisinternal)
     IS DISTINCT FROM ARRAY['assert_beneficiary_region_grain', 'assert_need_line_integrity', 'set_updated_at'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): the M213 table must carry exactly its own two triggers plus T4';
  END IF;
  IF (SELECT md5(string_agg(x, E'\n' ORDER BY x)) FROM (
        SELECT 'col ' || attname || ' ' || format_type(atttypid, atttypmod) || ' ' || attnotnull::text
               || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
          FROM pg_attribute a
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = 'public.central_needs_beneficiary_column_mappings'::regclass
           AND a.attnum > 0 AND NOT a.attisdropped
        UNION ALL
        SELECT 'con ' || conname || ' ' || pg_get_constraintdef(oid)
          FROM pg_constraint WHERE conrelid = 'public.central_needs_beneficiary_column_mappings'::regclass AND contype <> 't'
        UNION ALL
        SELECT 'idx ' || indexrelid::regclass::text || ' ' || pg_get_indexdef(indexrelid)
          FROM pg_index WHERE indrelid = 'public.central_needs_beneficiary_column_mappings'::regclass
        UNION ALL
        SELECT 'pol ' || polname || ' ' || polcmd::text || ' ' || polpermissive::text || ' '
               || coalesce(pg_get_expr(polqual, polrelid), '') || ' ' || coalesce(pg_get_expr(polwithcheck, polrelid), '')
          FROM pg_policy WHERE polrelid = 'public.central_needs_beneficiary_column_mappings'::regclass
      ) s(x))
     IS DISTINCT FROM current_setting('phoenix_m216.m213_surface', true) THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): the M213 table''s columns, constraints, indexes or policies changed';
  END IF;

  -- Internal functions are not client-callable, and pin search_path.
  FOREACH v_sig IN ARRAY v_internal LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED (216): % is missing', v_sig;
    END IF;
    IF has_function_privilege('public', v_sig, 'EXECUTE')
       OR has_function_privilege('anon', v_sig, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (216): internal % is client-callable', v_sig;
    END IF;
    IF NOT COALESCE((SELECT 'search_path=public, pg_temp' = ANY (p.proconfig)
                       FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)), false) THEN
      RAISE EXCEPTION 'VERIFY FAILED (216): % does not pin search_path = public, pg_temp', v_sig;
    END IF;
  END LOOP;

  -- The write RPC: SECURITY DEFINER, pinned search_path, authenticated only.
  IF to_regprocedure(v_rpc) IS NULL
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_rpc))
     OR NOT COALESCE((SELECT 'search_path=public, pg_temp' = ANY (p.proconfig)
                        FROM pg_proc p WHERE p.oid = to_regprocedure(v_rpc)), false)
     OR NOT has_function_privilege('authenticated', v_rpc, 'EXECUTE')
     OR has_function_privilege('anon', v_rpc, 'EXECUTE')
     OR has_function_privilege('public', v_rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): the region write RPC security properties are wrong';
  END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'phoenix_central_needs_set_beneficiary_regions';
  IF n <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): exactly one region write RPC must exist (got %)', n;
  END IF;

  -- set_need_line: the exact M212 signature, the M213 codes and the new ones.
  IF NOT has_function_privilege('authenticated', v_set_line, 'EXECUTE')
     OR has_function_privilege('anon', v_set_line, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): phoenix_central_needs_set_need_line signature or grant changed';
  END IF;
  v_def := pg_get_functiondef(to_regprocedure(v_set_line));
  FOREACH v_code IN ARRAY ARRAY[
    'beneficiary_column_mapping_required', 'beneficiary_column_not_beneficiary',
    'beneficiary_column_mapping_conflict', 'beneficiary_decision_grain_conflict',
    'beneficiary_region_required', 'beneficiary_region_overlap',
    'beneficiary_region_not_beneficiary', 'beneficiary_region_mapping_conflict',
    '_phoenix_central_needs_resolve_column_mapping_v1'
  ] LOOP
    IF position(v_code IN v_def) = 0 THEN
      RAISE EXCEPTION 'VERIFY FAILED (216): set_need_line lacks %', v_code;
    END IF;
  END LOOP;

  -- The integrity function keeps M213's in-use refusal and gains T5'.
  v_def := pg_get_functiondef(to_regprocedure('public._phoenix_central_needs_assert_need_line_integrity_v1()'));
  FOREACH v_code IN ARRAY ARRAY[
    'beneficiary_column_mapping_in_use', 'beneficiary_column_mapping_conflict',
    'need_line_requires_source_lineage', 'need_line_quantity_provenance_mismatch',
    'need_line_material_mapping_conflict', 'need_line_scope_mixes_institution_and_warehouse',
    'beneficiary_region_in_use', 'beneficiary_region_mapping_conflict',
    '_phoenix_central_needs_region_column_covered_v1'
  ] LOOP
    IF position(v_code IN v_def) = 0 THEN
      RAISE EXCEPTION 'VERIFY FAILED (216): the integrity function lacks %', v_code;
    END IF;
  END LOOP;

  -- The blockers function holds the 13 prior codes plus the 5 new ones.
  v_def := pg_get_functiondef(to_regprocedure('public._phoenix_central_needs_review_blockers_v1(uuid)'));
  FOREACH v_code IN ARRAY ARRAY[
    'no_finalized_import', 'import_session_still_open', 'completed_session_not_in_trusted_batch',
    'incomplete_trusted_batch', 'target_entity_without_disposition',
    'mapped_target_entity_without_need_line', 'need_line_material_mapping_divergent',
    'need_line_unit_conversion_required', 'need_line_warehouse_org_mismatch',
    'need_line_target_warehouse_not_active', 'need_line_beneficiary_ineligible',
    'beneficiary_column_cell_without_need_line', 'beneficiary_column_review_required',
    'beneficiary_region_cell_uncovered', 'beneficiary_region_cell_without_need_line',
    'beneficiary_region_overlap', 'beneficiary_decision_grain_conflict',
    'beneficiary_region_geometry_invalid'
  ] LOOP
    IF position('''' || v_code || '''' IN v_def) = 0 THEN
      RAISE EXCEPTION 'VERIFY FAILED (216): the blockers function lacks %', v_code;
    END IF;
  END LOOP;

  -- list_beneficiary_columns: still SECURITY INVOKER with the same shape.
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_list))
     OR pg_get_function_result(to_regprocedure(v_list)) IS DISTINCT FROM
        'TABLE(import_session_id uuid, original_filename text, archive_entry_path text, sheet_index integer, sheet_name text, column_index integer, source_field_name text, numeric_value_count bigint, zero_value_count bigint, nonzero_numeric_count bigint, mapping_id uuid, column_decision text, beneficiary_organization_id uuid, mapping_reason text, mapped_at timestamp with time zone, mapped_row_numeric_count bigint, review_required boolean)'
     OR NOT has_function_privilege('authenticated', v_list, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): list_beneficiary_columns changed shape or security';
  END IF;

  -- Unchanged neighbours: the readiness wrapper stays VOLATILE.
  IF (SELECT p.provolatile FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.phoenix_central_needs_review_readiness(uuid)')) <> 'v' THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): review_readiness must stay VOLATILE';
  END IF;

  -- No Central Needs permission key was added or removed.
  SELECT count(*) INTO n FROM public.permission_keys WHERE module = 'central_needs';
  IF n <> 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): central_needs permission key count changed (got %)', n;
  END IF;

  -- NO BACKFILL.
  SELECT count(*) INTO n FROM public.central_needs_beneficiary_regions;
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): migration must not create any region version (got %)', n;
  END IF;

  -- The safe extractor behaves as specified.
  IF public._phoenix_central_needs_safe_coordinate_v1('7'::jsonb, 16383) IS DISTINCT FROM 7
     OR public._phoenix_central_needs_safe_coordinate_v1('"7"'::jsonb, 16383) IS NOT NULL
     OR public._phoenix_central_needs_safe_coordinate_v1('7.5'::jsonb, 16383) IS NOT NULL
     OR public._phoenix_central_needs_safe_coordinate_v1('-1'::jsonb, 16383) IS NOT NULL
     OR public._phoenix_central_needs_safe_coordinate_v1('16384'::jsonb, 16383) IS NOT NULL
     OR public._phoenix_central_needs_safe_coordinate_v1(NULL, 16383) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (216): the safe coordinate extractor misbehaves';
  END IF;
END;
$verify$;

COMMIT;
