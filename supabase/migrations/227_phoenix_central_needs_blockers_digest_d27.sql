-- MIGRATION 227 (R1-a 05). D9 CLOSED: numbered from supabase/candidates/R1a_05_blockers_digest_d27.sql WITHOUT any change to the SQL below.
-- The bytes after this prelude are exactly the candidate (SHA-256 fab489952b7405fe0f6902fdf0ef2b145f757cf9da111ae6fa395e55cfb65f69) that Staging already carries in its ledger;
-- wording below that says "PLACEHOLDER", "NOT part of the numbered chain" or "D9 open" predates this numbering and is superseded by this prelude.
-- ============================================================================
-- R1-a CANDIDATE 05 — mode-gated review blockers, manual submission digest section,
-- and the D27 Excel-history read restriction (INERT until an activation marker exists).
-- PLACEHOLDER (no migration number): NOT part of the numbered chain, NOT approved for apply.
-- Requires candidates 01–04.
--
--  * The M217 Excel blocker body is moved BYTE-FOR-BYTE into a private function; the public
--    _phoenix_central_needs_review_blockers_v1 keeps its signature/attributes and returns that
--    body for Excel (and unknown) revisions, the manual blockers for manual revisions.
--  * The M218 digest is re-created unchanged for Excel revisions (identical bytes); a manual
--    revision additionally commits its event chain and coverage acknowledgements.
--  * D27 (7 relations: source files/records/overrides/need lines/need-line sources + import batches/entries, the gateway of the
--    signed-URL download): while NO activation marker exists for the organization, every new policy passes
--    (behaviour unchanged). After a marker exists, EXCEL-mode quantity-bearing rows are readable
--    only by holders of central_needs.approve / central_needs.import (Q-K placeholder keys).
--    authorize_excel_download_v1 and the promotion RPC are NOT defined here (Q-ST/Q-W0 open).
-- ============================================================================
BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.phoenix_central_needs_add_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'R1a05_precondition_failed: candidates 01-04 must be applied first';
  END IF;
  IF to_regprocedure('phoenix_private.central_needs_excel_review_blockers_v1(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'R1a05_precondition_failed: already applied';
  END IF;
END
$pre$;

-- 1. Excel blockers: the M217 body, unchanged, in a private function
CREATE FUNCTION phoenix_private.central_needs_excel_review_blockers_v1(
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
  -- 217: reason token appended (C5 §4 readiness ids/reason).
  SELECT 'need_line_warehouse_org_mismatch',
         format('need_line=%s warehouse=%s reason=not_owned', n.id, n.target_warehouse_id)
    FROM public.central_needs_need_lines n
    JOIN public.warehouses w ON w.id = n.target_warehouse_id
   WHERE n.plan_revision_id = p_plan_revision_id
     AND n.target_warehouse_id IS NOT NULL
     AND w.organization_id IS DISTINCT FROM n.beneficiary_organization_id

  UNION ALL
  -- 217: reason token appended; not_owned wins over not_active (C5 §4), so a
  --      warehouse the beneficiary does not own is reported only above.
  SELECT 'need_line_target_warehouse_not_active',
         format('need_line=%s warehouse=%s status=%s reason=not_active', n.id, n.target_warehouse_id, w.status)
    FROM public.central_needs_need_lines n
    JOIN public.warehouses w ON w.id = n.target_warehouse_id
   WHERE n.plan_revision_id = p_plan_revision_id
     AND n.target_warehouse_id IS NOT NULL
     AND w.status IS DISTINCT FROM 'active'
     AND w.organization_id IS NOT DISTINCT FROM n.beneficiary_organization_id

  UNION ALL
  -- 217: an archived beneficiary is ineligible too, and the DETAIL carries the
  --      reason (not_care_institution, then inactive, then archived — C5 §4).
  SELECT 'need_line_beneficiary_ineligible',
         format('need_line=%s beneficiary=%s reason=%s', n.id, n.beneficiary_organization_id,
                CASE WHEN o.organization_kind IS DISTINCT FROM 'care_institution' THEN 'not_care_institution'
                     WHEN o.status IS DISTINCT FROM 'active' THEN 'inactive'
                     ELSE 'archived' END)
    FROM public.central_needs_need_lines n
    JOIN public.organizations o ON o.id = n.beneficiary_organization_id
   WHERE n.plan_revision_id = p_plan_revision_id
     AND (o.organization_kind IS DISTINCT FROM 'care_institution'
          OR o.status IS DISTINCT FROM 'active'
          OR o.archived_at IS NOT NULL)

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
     AND public._phoenix_central_needs_review_numeric_class_v1(r.source_values) IN ('native_number', 'canonical_integer_text', 'ambiguous_numeric_text')
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
         AND public._phoenix_central_needs_review_numeric_class_v1(r.source_values) IN ('native_number', 'canonical_integer_text', 'ambiguous_numeric_text')
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
         AND public._phoenix_central_needs_review_numeric_class_v1(r.source_values) IN ('native_number', 'canonical_integer_text', 'ambiguous_numeric_text')
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
     AND public._phoenix_central_needs_review_numeric_class_v1(r.source_values) IN ('native_number', 'canonical_integer_text', 'ambiguous_numeric_text')
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
     AND x.reason IS NOT NULL

  UNION ALL
  -- 217 (19). C5 §7.1 — structurally invalid immutable source evidence in a
  --      completed session of a DRAFT revision: the same read-only enumeration
  --      as activation precondition 2. Stage SOURCE; never repaired in place.
  SELECT 'source_cell_value_contract_invalid',
         format('session=%s source_record=%s reason=invalid_evidence', r.import_session_id, r.id)
    FROM public.central_needs_plan_revisions v
    JOIN public.central_needs_import_sessions s
      ON s.plan_revision_id = v.id AND s.status = 'completed'
    JOIN public.central_needs_source_records r ON r.import_session_id = s.id
   WHERE v.id = p_plan_revision_id
     AND v.status = 'draft'
     AND public._phoenix_central_needs_review_numeric_class_v1(r.source_values) = 'invalid_evidence'

  UNION ALL
  -- 217 (20). C5 §7.2 — a need-line source link whose quantity lineage the
  --      shared helper refuses (the helper is NULL for a non-DRAFT owner).
  --      Stage NEED-LINES; the same code and DETAIL tokens as the immediate
  --      set_need_line refusal and the deferred-trigger refusal.
  SELECT 'need_line_quantity_lineage_unsafe',
         format('session=%s source_record=%s need_line=%s reason=%s',
                r.import_session_id, ls.source_record_id, ls.need_line_id, h.reason)
    FROM public.central_needs_need_lines n
    JOIN public.central_needs_need_line_sources ls ON ls.need_line_id = n.id
    JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
    CROSS JOIN LATERAL (SELECT public._phoenix_central_needs_quantity_lineage_violation_v1(ls.id) AS reason) h
   WHERE n.plan_revision_id = p_plan_revision_id
     AND h.reason IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_excel_review_blockers_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 2. The public single definition of review completeness, mode-gated
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_review_blockers_v1(
  p_plan_revision_id uuid
)
RETURNS TABLE (blocker text, detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT x.blocker, x.detail
    FROM phoenix_private.central_needs_excel_review_blockers_v1(p_plan_revision_id) x
   WHERE COALESCE((SELECT r.source_mode FROM public.central_needs_plan_revisions r WHERE r.id = p_plan_revision_id), 'excel') = 'excel'

  UNION ALL
  SELECT 'manual_revision_has_no_lines'::text, NULL::text
    FROM public.central_needs_plan_revisions r
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual'
     AND NOT EXISTS (SELECT 1 FROM public.central_needs_need_lines n WHERE n.plan_revision_id = r.id)

  UNION ALL
  SELECT 'manual_revision_has_import_evidence', format('session=%s', s.id)
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_import_sessions s ON s.plan_revision_id = r.id
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual'

  UNION ALL
  -- projection must equal the last non-void event of its scope
  SELECT 'manual_projection_event_divergence', format('need_line=%s', n.id)
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_need_lines n ON n.plan_revision_id = r.id
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual'
     AND NOT EXISTS (
       SELECT 1 FROM public.central_needs_manual_need_events e
        WHERE e.plan_revision_id = n.plan_revision_id AND e.beneficiary_organization_id = n.beneficiary_organization_id
          AND e.central_item_id = n.central_item_id AND e.target_warehouse_id IS NOT DISTINCT FROM n.target_warehouse_id
          AND e.event_kind <> 'void' AND e.quantity_text = n.approved_quantity::text AND e.approved_unit IS NOT DISTINCT FROM n.approved_unit
          AND e.event_seq = (SELECT max(e2.event_seq) FROM public.central_needs_manual_need_events e2
                              WHERE e2.plan_revision_id = e.plan_revision_id AND e2.beneficiary_organization_id = e.beneficiary_organization_id
                                AND e2.central_item_id = e.central_item_id AND e2.target_warehouse_id IS NOT DISTINCT FROM e.target_warehouse_id))

  UNION ALL
  SELECT 'manual_event_without_line', format('event=%s', e.id)
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_manual_need_events e ON e.plan_revision_id = r.id
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual' AND e.event_kind <> 'void'
     AND e.event_seq = (SELECT max(e2.event_seq) FROM public.central_needs_manual_need_events e2
                         WHERE e2.plan_revision_id = e.plan_revision_id AND e2.beneficiary_organization_id = e.beneficiary_organization_id
                           AND e2.central_item_id = e.central_item_id AND e2.target_warehouse_id IS NOT DISTINCT FROM e.target_warehouse_id)
     AND NOT EXISTS (SELECT 1 FROM public.central_needs_need_lines n
                      WHERE n.plan_revision_id = e.plan_revision_id AND n.beneficiary_organization_id = e.beneficiary_organization_id
                        AND n.central_item_id = e.central_item_id AND n.target_warehouse_id IS NOT DISTINCT FROM e.target_warehouse_id)

  UNION ALL
  SELECT 'manual_line_beneficiary_ineligible',
         format('need_line=%s beneficiary=%s reason=%s', n.id, n.beneficiary_organization_id,
                CASE WHEN o.organization_kind IS DISTINCT FROM 'care_institution' THEN 'not_care_institution'
                     WHEN o.status IS DISTINCT FROM 'active' THEN 'inactive' ELSE 'archived' END)
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_need_lines n ON n.plan_revision_id = r.id
    JOIN public.organizations o ON o.id = n.beneficiary_organization_id
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual'
     AND (o.organization_kind IS DISTINCT FROM 'care_institution' OR o.status IS DISTINCT FROM 'active' OR o.archived_at IS NOT NULL)

  UNION ALL
  SELECT 'manual_line_item_not_active', format('need_line=%s item=%s status=%s', n.id, n.central_item_id, i.status)
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_need_lines n ON n.plan_revision_id = r.id
    JOIN public.central_items i ON i.id = n.central_item_id
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual' AND i.status IS DISTINCT FROM 'active'

  UNION ALL
  SELECT 'manual_line_unit_mismatch', format('need_line=%s item=%s unit=%s catalog_unit=%s', n.id, n.central_item_id, n.approved_unit, i.unit)
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_need_lines n ON n.plan_revision_id = r.id
    JOIN public.central_items i ON i.id = n.central_item_id
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual' AND n.approved_unit IS DISTINCT FROM i.unit

  UNION ALL
  SELECT 'manual_line_warehouse_ineligible', format('need_line=%s warehouse=%s', n.id, n.target_warehouse_id)
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_need_lines n ON n.plan_revision_id = r.id AND n.target_warehouse_id IS NOT NULL
    JOIN public.warehouses w ON w.id = n.target_warehouse_id
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual'
     AND (w.organization_id IS DISTINCT FROM n.beneficiary_organization_id OR w.status IS DISTINCT FROM 'active')

  UNION ALL
  -- coverage-v1: scopes of the effective predecessor missing from this revision need an acknowledgement
  SELECT 'manual_coverage_unacknowledged', format('predecessor=%s omitted_scopes=%s', p.id, c.omitted_scope_count)
    FROM public.central_needs_plan_revisions r
    CROSS JOIN LATERAL (SELECT phoenix_private.central_needs_effective_predecessor_v1(r.id) AS id) p
    CROSS JOIN LATERAL phoenix_private.central_needs_coverage_digest_v1(r.id, p.id) c
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual' AND p.id IS NOT NULL AND c.omitted_scope_count > 0
     AND NOT EXISTS (SELECT 1 FROM public.central_needs_manual_coverage_acknowledgements a
                      WHERE a.plan_revision_id = r.id AND a.omitted_scope_digest = c.omitted_scope_digest);
$$;
REVOKE ALL ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid) FROM PUBLIC, anon, authenticated;

-- 3. Submission digest: Excel bytes identical; a manual revision also commits events + acknowledgements
CREATE OR REPLACE FUNCTION phoenix_private.central_needs_submission_state_digest_v1(p_plan_revision_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH
  rev AS (
    SELECT r.id, r.plan_id, r.organization_id, r.revision_number
      FROM public.central_needs_plan_revisions r
     WHERE r.id = p_plan_revision_id
  ),
  ses AS (
    SELECT s.id, s.source_file_id, s.status, s.preview_digest, s.authoritative_digest, s.parser_identity, s.entry_path
      FROM public.central_needs_import_sessions s
     WHERE s.plan_revision_id = p_plan_revision_id
  ),
  lin AS (
    SELECT n.id, n.beneficiary_organization_id, n.target_warehouse_id, n.central_item_id, n.approved_quantity,
           n.approved_unit, n.unit_conversion_state, n.source_unit_text, n.mapping_reason
      FROM public.central_needs_need_lines n
     WHERE n.plan_revision_id = p_plan_revision_id
  ),
  lnk AS (
    SELECT l.id, l.need_line_id, l.source_record_id, l.designated_quantity, l.applied_override_id
      FROM public.central_needs_need_line_sources l
     WHERE l.id IN (SELECT l1.id FROM public.central_needs_need_line_sources l1
                     WHERE l1.need_line_id IN (SELECT lin.id FROM lin)
                    UNION
                    SELECT l2.id FROM public.central_needs_need_line_sources l2
                     WHERE l2.source_record_id IN (SELECT sr.id FROM public.central_needs_source_records sr
                                                    WHERE sr.import_session_id IN (SELECT ses.id FROM ses)))
  ),
  rec AS (
    SELECT sr.id, sr.import_session_id, sr.record_ordinal, sr.target_entity, sr.field_name, sr.source_values, sr.source_provenance
      FROM public.central_needs_source_records sr
     WHERE sr.id IN (SELECT r1.id FROM public.central_needs_source_records r1
                      WHERE r1.import_session_id IN (SELECT ses.id FROM ses)
                     UNION
                     SELECT lnk.source_record_id FROM lnk)
  ),
  map AS (
    SELECT m.id, m.import_session_id, m.target_entity, m.decision, m.central_item_id, m.decision_reason
      FROM public.central_needs_record_mappings m
     WHERE m.import_session_id IN (SELECT rec.import_session_id FROM rec
                                   UNION
                                   SELECT ses.id FROM ses)
  ),
  ovr AS (
    SELECT o.id, o.plan_revision_id, o.source_record_id, o.target_entity, o.field_name, o.previous_value, o.final_value,
           o.override_reason, o.override_note, o.override_reference, o.created_at
      FROM public.central_needs_field_overrides o
     WHERE o.id IN (SELECT o1.id FROM public.central_needs_field_overrides o1
                     WHERE o1.plan_revision_id = p_plan_revision_id
                    UNION
                    SELECT o2.id FROM public.central_needs_field_overrides o2
                     WHERE o2.source_record_id IN (SELECT lnk.source_record_id FROM lnk)
                    UNION
                    SELECT lnk.applied_override_id FROM lnk WHERE lnk.applied_override_id IS NOT NULL)
  ),
  bat AS (
    SELECT b.id, b.container_kind, b.container_sha256, b.accepted_entry_count, b.excluded_entry_count,
           b.reconciliation, b.parser_identity
      FROM public.central_needs_import_batches b
     WHERE b.plan_revision_id = p_plan_revision_id
  ),
  ent AS (
    SELECT e.id, e.batch_id, e.import_session_id, e.entry_ordinal, e.archive_entry_path, e.entry_sha256
      FROM public.central_needs_import_batch_entries e
     WHERE e.id IN (SELECT e1.id FROM public.central_needs_import_batch_entries e1
                     WHERE e1.batch_id IN (SELECT bat.id FROM bat)
                    UNION
                    SELECT e2.id FROM public.central_needs_import_batch_entries e2
                     WHERE e2.import_session_id IN (SELECT ses.id FROM ses))
  ),
  col AS (
    SELECT c.id, c.import_session_id, c.sheet_index, c.column_index, c.decision, c.beneficiary_organization_id,
           c.source_field_name, c.mapping_reason
      FROM public.central_needs_beneficiary_column_mappings c
     WHERE c.id IN (SELECT c1.id FROM public.central_needs_beneficiary_column_mappings c1
                     WHERE c1.plan_revision_id = p_plan_revision_id
                    UNION
                    SELECT c2.id FROM public.central_needs_beneficiary_column_mappings c2
                     WHERE c2.import_session_id IN (SELECT ses.id FROM ses))
  ),
  reg AS (
    SELECT g.version_id, g.region_id, g.version_no, g.supersedes_version_id, g.import_session_id, g.sheet_index,
           g.row_start, g.row_end, g.column_start, g.column_end, g.decision, g.beneficiary_organization_id,
           g.decision_reason, g.retired_at, g.retirement_kind
      FROM public.central_needs_beneficiary_regions g
     WHERE g.version_id IN (SELECT g1.version_id FROM public.central_needs_beneficiary_regions g1
                             WHERE g1.plan_revision_id = p_plan_revision_id
                            UNION
                            SELECT g2.version_id FROM public.central_needs_beneficiary_regions g2
                             WHERE g2.import_session_id IN (SELECT ses.id FROM ses))
  ),
  fil AS (
    SELECT f.id, f.file_hash
      FROM public.central_needs_source_files f
     WHERE f.id IN (SELECT ses.source_file_id FROM ses)
  ),
  mode AS (
    SELECT r.source_mode FROM public.central_needs_plan_revisions r WHERE r.id = p_plan_revision_id
  ),
  mev AS (
    SELECT e.id, e.beneficiary_organization_id, e.central_item_id, e.target_warehouse_id, e.event_seq, e.event_kind, e.quantity_text,
           e.approved_unit, e.supersedes_event_id, e.carried_from_event_id, e.reason, e.reference, e.actor_id, e.idempotency_key, e.need_line_id
      FROM public.central_needs_manual_need_events e
     WHERE e.plan_revision_id = p_plan_revision_id
  ),
  ack AS (
    SELECT a.id, a.predecessor_revision_id, a.omitted_scope_digest, a.omitted_scope_count, a.reason
      FROM public.central_needs_manual_coverage_acknowledgements a
     WHERE a.plan_revision_id = p_plan_revision_id
  )
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((jsonb_build_array(
    'c6-f1-r1-state-v1',
    jsonb_build_array('revision', (SELECT jsonb_build_array(rev.id, rev.plan_id, rev.organization_id, rev.revision_number) FROM rev)),
    jsonb_build_array('sessions', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        ses.id, ses.source_file_id, ses.status, ses.preview_digest, ses.authoritative_digest, ses.parser_identity::text, ses.entry_path)
        ORDER BY ses.id), '[]'::jsonb) FROM ses)),
    jsonb_build_array('files', (SELECT COALESCE(jsonb_agg(jsonb_build_array(fil.id, fil.file_hash) ORDER BY fil.id), '[]'::jsonb) FROM fil)),
    jsonb_build_array('records', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        rec.id, rec.import_session_id, rec.record_ordinal, rec.target_entity, rec.field_name, rec.source_values::text, rec.source_provenance::text)
        ORDER BY rec.id), '[]'::jsonb) FROM rec)),
    jsonb_build_array('mappings', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        map.id, map.import_session_id, map.target_entity, map.decision, map.central_item_id, map.decision_reason)
        ORDER BY map.id), '[]'::jsonb) FROM map)),
    jsonb_build_array('overrides', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        ovr.id, ovr.plan_revision_id, ovr.source_record_id, ovr.target_entity, ovr.field_name, ovr.previous_value::text, ovr.final_value::text,
        ovr.override_reason, ovr.override_note, ovr.override_reference,
        CASE WHEN isfinite(ovr.created_at)
             THEN to_char(ovr.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US BC')
             ELSE ovr.created_at::text END)
        ORDER BY ovr.id), '[]'::jsonb) FROM ovr)),
    jsonb_build_array('batches', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        bat.id, bat.container_kind, bat.container_sha256, bat.accepted_entry_count, bat.excluded_entry_count,
        bat.reconciliation::text, bat.parser_identity::text)
        ORDER BY bat.id), '[]'::jsonb) FROM bat)),
    jsonb_build_array('entries', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        ent.id, ent.batch_id, ent.import_session_id, ent.entry_ordinal, ent.archive_entry_path, ent.entry_sha256)
        ORDER BY ent.id), '[]'::jsonb) FROM ent)),
    jsonb_build_array('columns', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        col.id, col.import_session_id, col.sheet_index, col.column_index, col.decision, col.beneficiary_organization_id,
        col.source_field_name, col.mapping_reason)
        ORDER BY col.id), '[]'::jsonb) FROM col)),
    jsonb_build_array('regions', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        reg.version_id, reg.region_id, reg.version_no, reg.supersedes_version_id, reg.import_session_id, reg.sheet_index,
        reg.row_start, reg.row_end, reg.column_start, reg.column_end, reg.decision, reg.beneficiary_organization_id,
        reg.decision_reason, reg.retired_at IS NOT NULL, reg.retirement_kind)
        ORDER BY reg.version_id), '[]'::jsonb) FROM reg)),
    jsonb_build_array('need_lines', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        lin.id, lin.beneficiary_organization_id, lin.target_warehouse_id, lin.central_item_id, lin.approved_quantity,
        lin.approved_unit, lin.unit_conversion_state, lin.source_unit_text, lin.mapping_reason)
        ORDER BY lin.id), '[]'::jsonb) FROM lin)),
    jsonb_build_array('links', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        lnk.id, lnk.need_line_id, lnk.source_record_id, lnk.designated_quantity, lnk.applied_override_id)
        ORDER BY lnk.id), '[]'::jsonb) FROM lnk))
  ) || CASE WHEN (SELECT mode.source_mode FROM mode) = 'manual' THEN jsonb_build_array(
    jsonb_build_array('manual_events', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        mev.id, mev.beneficiary_organization_id, mev.central_item_id, mev.target_warehouse_id, mev.event_seq, mev.event_kind, mev.quantity_text,
        mev.approved_unit, mev.supersedes_event_id, mev.carried_from_event_id, mev.reason, mev.reference, mev.actor_id, mev.idempotency_key, mev.need_line_id)
        ORDER BY mev.id), '[]'::jsonb) FROM mev)),
    jsonb_build_array('manual_coverage', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        ack.id, ack.predecessor_revision_id, ack.omitted_scope_digest, ack.omitted_scope_count, ack.reason)
        ORDER BY ack.id), '[]'::jsonb) FROM ack)))
    ELSE '[]'::jsonb END)::text, 'UTF8')), 'hex')
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_submission_state_digest_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;


-- 4. D27 — Excel-history read restriction (inert while no activation marker exists)
CREATE FUNCTION phoenix_cn_policy.excel_read_restriction_state(p_org uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.central_needs_cutover_inventory i
                            WHERE i.organization_id = p_org AND i.entry_kind = 'activation_marker')
              THEN 'active' ELSE 'inactive' END
$$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.excel_read_restriction_state(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.excel_read_restriction_state(uuid) TO authenticated;

-- decision for one revision: allowed_manual | allowed_inactive | allowed_authorized | denied
CREATE FUNCTION phoenix_cn_policy.excel_history_decision(p_revision uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
           WHEN r.id IS NULL THEN 'denied'
           WHEN r.source_mode = 'manual' THEN 'allowed_manual'
           WHEN phoenix_cn_policy.excel_read_restriction_state(r.organization_id) = 'inactive' THEN 'allowed_inactive'
           WHEN phoenix_cn_policy.actor_scope_org('central_needs.approve') = r.organization_id
             OR phoenix_cn_policy.actor_scope_org('central_needs.import') = r.organization_id THEN 'allowed_authorized'
           ELSE 'denied' END
    FROM (SELECT p_revision AS rid) q
    LEFT JOIN public.central_needs_plan_revisions r ON r.id = q.rid
$$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.excel_history_decision(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.excel_history_decision(uuid) TO authenticated;

CREATE FUNCTION phoenix_cn_policy.may_read_excel_history(p_revision uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT phoenix_cn_policy.excel_history_decision(p_revision) <> 'denied' $$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.may_read_excel_history(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.may_read_excel_history(uuid) TO authenticated;

CREATE FUNCTION phoenix_cn_policy.revision_of_session(p_session uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT s.plan_revision_id FROM public.central_needs_import_sessions s WHERE s.id = p_session $$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.revision_of_session(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.revision_of_session(uuid) TO authenticated;

CREATE FUNCTION phoenix_cn_policy.revision_of_need_line(p_line uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT n.plan_revision_id FROM public.central_needs_need_lines n WHERE n.id = p_line $$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.revision_of_need_line(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.revision_of_need_line(uuid) TO authenticated;

CREATE POLICY excel_history_read_restrictive ON public.central_needs_source_files AS RESTRICTIVE FOR SELECT
  USING (phoenix_cn_policy.may_read_excel_history(plan_revision_id));
CREATE POLICY excel_history_read_restrictive ON public.central_needs_source_records AS RESTRICTIVE FOR SELECT
  USING (phoenix_cn_policy.may_read_excel_history(phoenix_cn_policy.revision_of_session(import_session_id)));
CREATE POLICY excel_history_read_restrictive ON public.central_needs_field_overrides AS RESTRICTIVE FOR SELECT
  USING (phoenix_cn_policy.may_read_excel_history(plan_revision_id));
CREATE POLICY excel_history_read_restrictive ON public.central_needs_need_lines AS RESTRICTIVE FOR SELECT
  USING (phoenix_cn_policy.may_read_excel_history(plan_revision_id));
CREATE POLICY excel_history_read_restrictive ON public.central_needs_need_line_sources AS RESTRICTIVE FOR SELECT
  USING (phoenix_cn_policy.may_read_excel_history(phoenix_cn_policy.revision_of_need_line(need_line_id)));

-- F02 (Director review): the historical-source download path reads central_needs_import_batches AS THE CALLER and then
-- authorizes only central_needs.view before minting a signed URL. The batch row (storage_locator, container_sha256) and
-- its entries are therefore the gateway to the Excel bytes and carry the same D27 restriction. Still inert until a marker.
CREATE POLICY excel_history_read_restrictive ON public.central_needs_import_batches AS RESTRICTIVE FOR SELECT
  USING (phoenix_cn_policy.may_read_excel_history(plan_revision_id));
CREATE POLICY excel_history_read_restrictive ON public.central_needs_import_batch_entries AS RESTRICTIVE FOR SELECT
  USING (phoenix_cn_policy.may_read_excel_history(phoenix_cn_policy.revision_of_session(import_session_id)));

-- 5. Seal ACL manifest restated
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
           ('public._phoenix_central_needs_review_blockers_v1(uuid)')
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
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_policy WHERE polname = 'excel_history_read_restrictive' AND NOT polpermissive AND polcmd = 'r') <> 7 THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a05): expected 7 excel_history_read_restrictive policies';
  END IF;
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a05): capability seal reports breaches: %',
      (SELECT string_agg(b, '; ') FROM phoenix_private.central_needs_capability_breaches_v1() AS b);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = 'phoenix_private.central_needs_excel_review_blockers_v1(uuid)'::regprocedure
               AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a05): the private Excel blockers function is reachable';
  END IF;
END
$verify$;

COMMIT;
