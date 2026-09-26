-- ===========================================================================
-- C5 / M217 — CENTRAL NEEDS C5 SAFETY CONVERGENCE
--
-- WHY THIS MIGRATION EXISTS
--   The ratified C5 contract (v1.9, Final Activation-Freeze Closure) closes the
--   confirmed A1 (review completeness) and A2 (approval-time eligibility)
--   safety defects of the Central Needs workflow. This is the ONE forward
--   migration that converges the database side of C5 (contract §22). M209-M216
--   are immutable and untouched.
--
-- WHAT THIS MIGRATION ADDS
--   1. The frozen review classifier _phoenix_central_needs_review_numeric_class_v1
--      (IMMUTABLE, CALLED ON NULL INPUT, SECURITY INVOKER; §5).
--   2. The shared quantity-lineage helper
--      _phoenix_central_needs_quantity_lineage_violation_v1 (§9; no client EXECUTE).
--   3. The future-write source-value guard: a NOT VALID CHECK on
--      central_needs_source_records (§8). Historical evidence is not rescanned.
--   4. Behaviour-only replacements, identical signatures:
--        _phoenix_central_needs_assert_beneficiary_v1   (archived beneficiary, §4)
--        _phoenix_central_needs_review_blockers_v1      (A1 candidates, A2 reasons,
--                                                        two C5 blockers, §6/§7)
--        phoenix_central_needs_list_beneficiary_columns (classifier-backed, §8)
--        phoenix_central_needs_set_need_line            (lexeme + helper, §10)
--        _phoenix_central_needs_assert_need_line_integrity_v1 (touched link, §11)
--        phoenix_central_needs_record_field_override    (chronology, §12)
--        phoenix_central_needs_approve_revision         (owner FOR SHARE, A2,
--                                                        approval gate, §3/§4/§16)
--   5. The approval fence: ONE BEFORE INSERT OR UPDATE trigger on
--      central_needs_plan_revisions (no column list, §16).
--
-- ACTIVATION PRECONDITIONS AND LOCK BUDGET (§1)
--   READ COMMITTED is asserted; the migration refuses to run twice; it sets
--   LOCAL lock_timeout = 250ms and statement_timeout = 60s, then takes exactly
--   central_needs_source_records ACCESS EXCLUSIVE NOWAIT and
--   central_needs_plan_revisions EXCLUSIVE NOWAIT, held to COMMIT. After the
--   pair: plain-SELECT preconditions only (zero submitted revisions, zero DRAFT
--   invalid source evidence, zero DRAFT unsafe quantity-lineage links), no
--   business-table DML, no row or advisory locks, no DROP TRIGGER, no VALIDATE.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * no edit of any M209-M216 file, table, index, policy or existing trigger;
--   * ACL-NEUTRAL for phoenix_central_needs_submit_revision(uuid),
--     phoenix_central_needs_approve_revision(uuid) and
--     phoenix_central_needs_reject_revision(uuid, text): no GRANT, no REVOKE,
--     no DROP; VERIFY proves their privileges are byte-identical before and
--     after, and never asserts their final client grants (§2.6/§22);
--   * no backfill, no repair, no status or audit write;
--   * no change to submit, reject, review_readiness or any M215 lifecycle
--     function other than approve.
--
-- ACTIVATION RUNBOOK
--   The Production freeze/restore DCL around this migration (T0/S0/A0/ACL0
--   snapshot, complete EXECUTE freeze, drains, governed rejections, Proof A/B,
--   exact restore) belongs to the separately authorized activation runbook
--   (docs/phoenix/C5-ACTIVATION-RUNBOOK.md, tools/phoenix-demo/c5-activation-*),
--   never to migration history.
-- ===========================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0a. Transaction shape, idempotence and dependencies — BEFORE any relation
--     lock. Catalog reads only.
-- ----------------------------------------------------------------------------
DO $prelude$
DECLARE
  f text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '217_requires_read_committed'
      USING DETAIL = format('transaction_isolation=%s', current_setting('transaction_isolation'));
  END IF;

  -- The C5 tables are FORCE ROW LEVEL SECURITY with client-only policies: an
  -- applying role that does not bypass RLS would read every precondition and
  -- the VERIFY fingerprint as empty and pass vacuously. Refuse it.
  IF NOT (SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION '217_precondition_failed: the applying role must bypass row-level security'
      USING DETAIL = format('role=%s', current_user);
  END IF;

  IF to_regprocedure('public._phoenix_central_needs_review_numeric_class_v1(jsonb)') IS NOT NULL
     OR to_regprocedure('public._phoenix_central_needs_quantity_lineage_violation_v1(uuid)') IS NOT NULL
     OR to_regprocedure('public._phoenix_central_needs_approval_gate_fence_v1()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'central_needs_plan_revisions_c5_approval_gate')
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'central_needs_source_records_c5_value_contract') THEN
    RAISE EXCEPTION '217_already_applied';
  END IF;

  FOREACH f IN ARRAY ARRAY[
    'central_needs_plans', 'central_needs_plan_revisions', 'central_needs_import_sessions',
    'central_needs_source_records', 'central_needs_record_mappings', 'central_needs_field_overrides',
    'central_needs_need_lines', 'central_needs_need_line_sources',
    'central_needs_beneficiary_column_mappings', 'central_needs_beneficiary_regions',
    'organizations', 'warehouses', 'audit_logs'
  ] LOOP
    IF to_regclass('public.' || f) IS NULL THEN
      RAISE EXCEPTION '217_precondition_failed: table % is absent', f;
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public._phoenix_central_needs_guard_v1(uuid, text)',
    'public._phoenix_central_needs_assert_org_live_v1(uuid)',
    'public._phoenix_central_needs_load_revision_v1(uuid)',
    'public._phoenix_central_needs_assert_draft_v1(uuid, text)',
    'public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid)',
    'public._phoenix_central_needs_lock_plan_family_v1(uuid, integer)',
    'public._phoenix_central_needs_assert_need_line_integrity_v1()',
    'public._phoenix_central_needs_review_blockers_v1(uuid)',
    'public._phoenix_central_needs_resolve_region_v1(uuid, jsonb)',
    'public._phoenix_central_needs_safe_coordinate_v1(jsonb, integer)',
    'public.phoenix_central_needs_list_beneficiary_columns(uuid)',
    'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)',
    'public.phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text)',
    'public.phoenix_central_needs_submit_revision(uuid)',
    'public.phoenix_central_needs_approve_revision(uuid)',
    'public.phoenix_central_needs_reject_revision(uuid, text)',
    'public.phoenix_central_needs_review_readiness(uuid)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION '217_precondition_failed: % is absent', f;
    END IF;
  END LOOP;

  -- ACL-neutrality baseline (§2.6/§22): the exact privileges of the three
  -- lifecycle RPCs as they are at apply time — frozen by the activation
  -- runbook in Production, unfrozen in CI. VERIFY compares, never asserts.
  PERFORM set_config('phoenix_m217.lifecycle_acl', (
    SELECT string_agg(p.oid::regprocedure::text || '=' || coalesce(p.proacl::text, '(default)'), ';' ORDER BY p.oid::regprocedure::text)
      FROM pg_proc p
     WHERE p.oid IN ('public.phoenix_central_needs_submit_revision(uuid)'::regprocedure,
                     'public.phoenix_central_needs_approve_revision(uuid)'::regprocedure,
                     'public.phoenix_central_needs_reject_revision(uuid, text)'::regprocedure)), true);
END
$prelude$;

SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '60s';

-- ----------------------------------------------------------------------------
-- 0b. The activation lock pair (§1) — the ONLY explicit application-table
--     locks, both held to COMMIT. NOWAIT: an in-flight writer makes M217 fail
--     closed instead of waiting behind it.
-- ----------------------------------------------------------------------------
LOCK TABLE public.central_needs_source_records IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.central_needs_plan_revisions IN EXCLUSIVE MODE NOWAIT;

-- ----------------------------------------------------------------------------
-- 1. The frozen review classifier (§5). Pure, deterministic, never raises and
--    never returns NULL. Rules, in order:
--     1 SQL NULL / non-object -> invalid_evidence
--     2 bad or missing valueType -> invalid_evidence
--     3 missing value -> invalid_evidence
--     4 string + JSON null -> not_numeric; 5 any other typed JSON null -> invalid
--     6 number + JSON number -> native_number
--     7 string + string: canonical integer (<= 256 chars) -> canonical_integer_text;
--       exact ASCII NaN/Inf/Infinity (signed) -> ambiguous; any digit in
--       U+0030-0039, U+0660-0669, U+06F0-06F9, U+FF10-FF19 -> ambiguous;
--       else not_numeric
--     8 boolean + boolean, 9 date + string/number, 10 error + string -> not_numeric
--     11 anything else -> invalid_evidence
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_review_numeric_class_v1(
  p_source_values jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
CALLED ON NULL INPUT
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_source_values IS NULL OR jsonb_typeof(p_source_values) <> 'object' THEN 'invalid_evidence'
    WHEN jsonb_typeof(p_source_values->'valueType') IS DISTINCT FROM 'string'
      OR (p_source_values->>'valueType') NOT IN ('number', 'string', 'boolean', 'date', 'error') THEN 'invalid_evidence'
    WHEN (p_source_values->'value') IS NULL THEN 'invalid_evidence'
    WHEN jsonb_typeof(p_source_values->'value') = 'null' THEN
      CASE WHEN p_source_values->>'valueType' = 'string' THEN 'not_numeric' ELSE 'invalid_evidence' END
    WHEN p_source_values->>'valueType' = 'number' AND jsonb_typeof(p_source_values->'value') = 'number' THEN 'native_number'
    WHEN p_source_values->>'valueType' = 'string' AND jsonb_typeof(p_source_values->'value') = 'string' THEN
      CASE
        WHEN char_length(p_source_values->>'value') <= 256
         AND (p_source_values->>'value') ~ '^(?:0|[1-9][0-9]*)$' THEN 'canonical_integer_text'
        WHEN (p_source_values->>'value') ~ '^[+-]?(?:[Nn][Aa][Nn]|[Ii][Nn][Ff]|[Ii][Nn][Ff][Ii][Nn][Ii][Tt][Yy])$' THEN 'ambiguous_numeric_text'
        WHEN (p_source_values->>'value') ~ '[\u0030-\u0039\u0660-\u0669\u06F0-\u06F9\uFF10-\uFF19]' THEN 'ambiguous_numeric_text'
        ELSE 'not_numeric'
      END
    WHEN p_source_values->>'valueType' = 'boolean' AND jsonb_typeof(p_source_values->'value') = 'boolean' THEN 'not_numeric'
    WHEN p_source_values->>'valueType' = 'date' AND jsonb_typeof(p_source_values->'value') IN ('string', 'number') THEN 'not_numeric'
    WHEN p_source_values->>'valueType' = 'error' AND jsonb_typeof(p_source_values->'value') = 'string' THEN 'not_numeric'
    ELSE 'invalid_evidence'
  END
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_review_numeric_class_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._phoenix_central_needs_review_numeric_class_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public._phoenix_central_needs_review_numeric_class_v1(jsonb) IS
  'C5 (217): the frozen review classifier v1 of one immutable source value: native_number | canonical_integer_text | ambiguous_numeric_text | not_numeric | invalid_evidence. Pure, deterministic, never raises, never NULL. The single authority the review blockers, the beneficiary-column list, the lineage helper and the source-record CHECK call; no inline duplicate exists.';

-- ----------------------------------------------------------------------------
-- 2. The shared quantity-lineage helper (§9). For ONE need-line source link:
--    missing/deleted link or non-DRAFT owner -> NULL; otherwise the FIRST
--    failure of: invalid evidence; native/canonical-integer -> NULL (safe);
--    ambiguous/not_numeric without an override; an override that is not the
--    current head of the same record in the same revision; a SQL/JSON-null,
--    non-number or negative override; a scale-insensitive numeric mismatch.
--    Never raises; every cast is guarded. Internal: no client EXECUTE.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_quantity_lineage_violation_v1(
  p_link_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN l.id IS NULL OR rv.status IS DISTINCT FROM 'draft' THEN NULL
    WHEN c.cls = 'invalid_evidence' THEN 'source_cell_value_contract_invalid'
    WHEN c.cls IN ('native_number', 'canonical_integer_text') THEN NULL
    WHEN l.applied_override_id IS NULL THEN 'source_quantity_requires_explicit_numeric_override'
    WHEN o.id IS NULL
      OR o.plan_revision_id IS DISTINCT FROM n.plan_revision_id
      OR o.source_record_id IS DISTINCT FROM l.source_record_id
      OR o.id IS DISTINCT FROM h.id THEN 'source_quantity_override_binding_invalid'
    WHEN o.final_value IS NULL
      OR jsonb_typeof(o.final_value) IS DISTINCT FROM 'number'
      OR (CASE WHEN jsonb_typeof(o.final_value) = 'number' THEN (o.final_value #>> '{}')::numeric END) < 0
      THEN 'source_quantity_override_value_invalid'
    WHEN (CASE WHEN jsonb_typeof(o.final_value) = 'number' THEN (o.final_value #>> '{}')::numeric END)
         IS DISTINCT FROM l.designated_quantity THEN 'source_quantity_override_mismatch'
    ELSE NULL
  END
  FROM (SELECT p_link_id AS link_id) x
  LEFT JOIN public.central_needs_need_line_sources l ON l.id = x.link_id
  LEFT JOIN public.central_needs_need_lines n ON n.id = l.need_line_id
  LEFT JOIN public.central_needs_plan_revisions rv ON rv.id = n.plan_revision_id
  LEFT JOIN public.central_needs_source_records sr ON sr.id = l.source_record_id
  LEFT JOIN public.central_needs_field_overrides o ON o.id = l.applied_override_id
  LEFT JOIN LATERAL (
    SELECT fo.id
      FROM public.central_needs_field_overrides fo
     WHERE fo.source_record_id = l.source_record_id
     ORDER BY fo.created_at DESC, fo.id DESC
     LIMIT 1
  ) h ON true
  CROSS JOIN LATERAL (SELECT public._phoenix_central_needs_review_numeric_class_v1(sr.source_values) AS cls) c
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_quantity_lineage_violation_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._phoenix_central_needs_quantity_lineage_violation_v1(uuid) IS
  'C5 (217) internal: the shared quantity-lineage core of ONE need-line source link, used by the review blockers, set_need_line and the deferred integrity trigger. NULL when safe, missing or not DRAFT; otherwise the first failure: source_cell_value_contract_invalid | source_quantity_requires_explicit_numeric_override | source_quantity_override_binding_invalid | source_quantity_override_value_invalid | source_quantity_override_mismatch. No writes, no dynamic SQL, never raises. Not client-callable (no EXECUTE for anon, authenticated or service_role).';

-- ----------------------------------------------------------------------------
-- 3. Activation data preconditions (§1) — plain SELECTs under the lock pair.
--    Fail closed rather than half-apply.
-- ----------------------------------------------------------------------------
DO $precondition$
DECLARE
  v_submitted     bigint;
  v_draft_invalid bigint;
  v_draft_unsafe  bigint;
BEGIN
  SELECT count(*) INTO v_submitted
    FROM public.central_needs_plan_revisions
   WHERE status = 'submitted';

  SELECT count(*) INTO v_draft_invalid
    FROM public.central_needs_source_records r
    JOIN public.central_needs_import_sessions s ON s.id = r.import_session_id AND s.status = 'completed'
    JOIN public.central_needs_plan_revisions v ON v.id = s.plan_revision_id AND v.status = 'draft'
   WHERE public._phoenix_central_needs_review_numeric_class_v1(r.source_values) = 'invalid_evidence';

  SELECT count(*) INTO v_draft_unsafe
    FROM public.central_needs_need_line_sources ls
    JOIN public.central_needs_need_lines n ON n.id = ls.need_line_id
    JOIN public.central_needs_plan_revisions v ON v.id = n.plan_revision_id AND v.status = 'draft'
   WHERE public._phoenix_central_needs_quantity_lineage_violation_v1(ls.id) IS NOT NULL;

  IF v_submitted > 0 OR v_draft_invalid > 0 OR v_draft_unsafe > 0 THEN
    RAISE EXCEPTION '217_precondition_failed'
      USING DETAIL = format('submitted=%s draft_invalid=%s draft_unsafe_links=%s',
                            v_submitted, v_draft_invalid, v_draft_unsafe),
            HINT = 'Resolve every submitted revision through the governed reject path and every DRAFT source/lineage defect before applying C5.';
  END IF;

  -- Status fingerprint of every plan revision: VERIFY proves M217 changed none.
  PERFORM set_config('phoenix_m217.revision_status', (
    SELECT coalesce(md5(string_agg(id::text || ':' || status, ',' ORDER BY id)), 'empty')
      FROM public.central_needs_plan_revisions), true);
END
$precondition$;

-- ----------------------------------------------------------------------------
-- 4. The future-write source-value guard (§8). NOT VALID: closed historical
--    evidence is not rescanned; every future write is judged immediately.
-- ----------------------------------------------------------------------------
ALTER TABLE public.central_needs_source_records
  ADD CONSTRAINT central_needs_source_records_c5_value_contract
  CHECK (COALESCE(public._phoenix_central_needs_review_numeric_class_v1(source_values), 'invalid_evidence') <> 'invalid_evidence') NOT VALID;

COMMENT ON CONSTRAINT central_needs_source_records_c5_value_contract ON public.central_needs_source_records IS
  'C5 (217): a new source record must carry a source value the frozen classifier does not judge invalid_evidence. NOT VALID by design: historical evidence is never rescanned or repaired in place.';

-- ----------------------------------------------------------------------------
-- 5. Beneficiary eligibility — archived beneficiaries (§4 write errors).
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
  v_kind      text;
  v_status    text;
  v_archived_at timestamptz;
  v_wh_org    uuid;
  v_wh_status text;
BEGIN
  IF p_beneficiary_organization_id IS NULL THEN
    RAISE EXCEPTION 'beneficiary_organization_required' USING ERRCODE = '23514';
  END IF;

  SELECT organization_kind, status, archived_at INTO v_kind, v_status, v_archived_at
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

  -- 217 ADDITION (C5 §4) — an archived beneficiary is refused on every write
  -- path. Checked after the status test, so an inactive beneficiary keeps its
  -- existing error (inactive wins over archived).
  IF v_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'beneficiary_organization_archived' USING ERRCODE = '23514',
      DETAIL = format('beneficiary=%s', p_beneficiary_organization_id),
      HINT = 'An archived organization cannot be a beneficiary of an annual need line.';
  END IF;

  IF p_target_warehouse_id IS NOT NULL THEN
    SELECT organization_id, status INTO v_wh_org, v_wh_status
      FROM public.warehouses
     WHERE id = p_target_warehouse_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_warehouse_not_found' USING ERRCODE = '23503';
    END IF;

    IF v_wh_org IS DISTINCT FROM p_beneficiary_organization_id THEN
      RAISE EXCEPTION 'target_warehouse_not_owned_by_beneficiary' USING ERRCODE = '23514';
    END IF;

    -- Ownership is not lifecycle. `warehouses.status` is ('active', 'inactive',
    -- 'archived') (001), and a warehouse the beneficiary still owns can be
    -- archived or inactivated. A NEW routing to it is refused here; a warehouse
    -- that stops being active AFTER a line was routed to it is caught by the
    -- `need_line_target_warehouse_not_active` review blocker instead, because
    -- this STABLE check cannot lock the warehouse row against a later change.
    IF v_wh_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'target_warehouse_not_active' USING ERRCODE = '23514',
        DETAIL = format('warehouse=%s status=%s', p_target_warehouse_id, v_wh_status),
        HINT = 'Route a requirement only to an active warehouse of the beneficiary.';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid) IS
  'CN-2B conformance (212, extended by 217) internal: the single definition of beneficiary eligibility — a live care_institution (not inactive, then not archived: beneficiary_organization_archived, 217), plus, when a target warehouse is named, that the warehouse belongs to the beneficiary AND is currently active. Server-side only; never trusts a UI-validated value.';

-- ----------------------------------------------------------------------------
-- 6. Behaviour-only replacement of _phoenix_central_needs_review_blockers_v1:
--    the M216 body with the four completeness branches classifier-backed (§6),
--    reason tokens on the three eligibility branches (§4), and two C5 blockers
--    appended (§7).
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

REVOKE ALL ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid) IS
  'CN-2B internal: the single definition of review completeness. The M216 body (M211''s five branches, M212''s nine, M213''s two, M216''s five) with three C5 changes (217): the four completeness branches count every C5 review candidate (native_number, canonical_integer_text, ambiguous_numeric_text by _phoenix_central_needs_review_numeric_class_v1), not only valueType number; the need-line eligibility branches carry reason tokens (archived beneficiaries included; not_owned wins over not_active); and two appended branches: source_cell_value_contract_invalid (stage SOURCE) and need_line_quantity_lineage_unsafe (stage NEED-LINES). Only review_readiness and submit call it.';

-- ----------------------------------------------------------------------------
-- 7. Behaviour-only replacement of phoenix_central_needs_list_beneficiary_columns:
--    same signature, same 17 columns, still SECURITY INVOKER (§8).
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
    count(*) FILTER (WHERE public._phoenix_central_needs_review_numeric_class_v1(r.source_values) = 'native_number')                                        AS numeric_value_count,
    count(*) FILTER (WHERE CASE WHEN public._phoenix_central_needs_review_numeric_class_v1(r.source_values) = 'native_number' THEN (r.source_values->>'value')::numeric = 0 ELSE false END) AS zero_value_count,
    count(*) FILTER (WHERE CASE WHEN public._phoenix_central_needs_review_numeric_class_v1(r.source_values) = 'native_number' THEN (r.source_values->>'value')::numeric <> 0 ELSE false END) AS nonzero_numeric_count,
    m.id                                                 AS mapping_id,
    m.decision                                           AS column_decision,
    m.beneficiary_organization_id,
    m.mapping_reason,
    m.mapped_at,
    -- (independent review finding 1) What makes a column review-relevant:
    -- numeric cells on rows a human dispositioned `mapped`, in completed
    -- sessions — the exact rule of the beneficiary_column_review_required
    -- blocker, so the picker's "blocks submission" marker is the server's.
    count(*) FILTER (WHERE public._phoenix_central_needs_review_numeric_class_v1(r.source_values) = 'native_number'
                       AND rm.decision = 'mapped' AND s.status = 'completed')         AS mapped_row_numeric_count,
    -- 217: review_required counts every C5 review candidate, exactly as the
    -- beneficiary_column_review_required blocker; the four native counts above
    -- stay native_number-only with CASE-guarded casts (C5 §6/§8).
    -- 216: narrowed exactly as blocker branch 13 — per cell, a cell whose
    -- safely extracted column is region-governed (an ACTIVE region spans it)
    -- is not counted. The extractor is inlined because an internal helper is
    -- never executable by the invoking client: a JSON number of plain
    -- decimal digits, and a column at most 16383.
    (m.id IS NULL
     AND count(*) FILTER (WHERE public._phoenix_central_needs_review_numeric_class_v1(r.source_values) IN ('native_number', 'canonical_integer_text', 'ambiguous_numeric_text')
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
  'CN-2B corrective extension (213, narrowed by 216, C5 217): the bounded, revision-level summary of every physical candidate beneficiary column — one row per (import_session_id, sheet_index, column_index), never one row per cell. SECURITY INVOKER: the caller''s own RLS decides visibility. The numeric counts are native_number-only with guarded casts (217); review_required is true exactly when the column has no decision yet but carries a C5 review candidate (native_number, canonical_integer_text or ambiguous_numeric_text) on a mapped row in a completed session outside any region-governed column — the same rule the beneficiary_column_review_required blocker enforces.';

-- ----------------------------------------------------------------------------
-- 8. Behaviour-only replacement of phoenix_central_needs_set_need_line: the
--    M216 body with the designatedQuantity lexeme and the shared lineage helper
--    on every written link (§10).
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
  v_c5_link      uuid;
  v_c5_reason    text;
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
    -- 217 ADDITION (C5 §10) — the designated quantity is a JSON STRING in the
    -- exact server decimal grammar, untrimmed and at most 256 characters,
    -- BEFORE any cast. JSON numbers, leading zeros, signs, exponents,
    -- grouping, whitespace, '.5' and '25.' are refused.
    IF jsonb_typeof(v_src->'designatedQuantity') IS DISTINCT FROM 'string'
       OR char_length(v_src->>'designatedQuantity') > 256
       OR (v_src->>'designatedQuantity') !~ '^(?:0|[1-9][0-9]*)(?:[.][0-9]+)?$' THEN
      RAISE EXCEPTION 'designated_quantity_not_canonical' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s', v_record_id),
        HINT = 'Send the designated quantity as a plain decimal string such as 25 or 12.5.';
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
      )
      RETURNING id INTO v_c5_link;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'central_needs_need_line_sources_record_key' THEN
        RAISE EXCEPTION 'source_record_already_linked' USING ERRCODE = '23514',
          DETAIL = format('source_record=%s', v_record_id),
          HINT = 'One imported cell can feed at most one need line. Reload and decide again.';
      END IF;
      RAISE;
    END;
    -- 217 ADDITION (C5 §7.2/§10) — the shared quantity-lineage helper judges
    -- the link just written. Any refusal rolls the whole call back.
    v_c5_reason := public._phoenix_central_needs_quantity_lineage_violation_v1(v_c5_link);
    IF v_c5_reason IS NOT NULL THEN
      RAISE EXCEPTION 'need_line_quantity_lineage_unsafe' USING ERRCODE = '23514',
        DETAIL = format('session=%s source_record=%s need_line=%s reason=%s',
                        v_record.import_session_id, v_record_id, v_line.id, v_c5_reason),
        HINT = 'This cell''s quantity is not safe to designate as recorded. Pin the current numeric override of the cell, or correct the designation.';
    END IF;
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
  'CN-2B (212, extended by 213, 216 and C5 217): identical public contract to M212. For every designated source record the cell''s beneficiary is proven server-side at the cell''s grain: its sheet and column must be safely locatable; a column that an ACTIVE beneficiary region spans resolves through exactly one covering ACTIVE region (beneficiary_region_required / _overlap / _not_beneficiary / _mapping_conflict), and a column with an M213 row and a region is a conflict (beneficiary_decision_grain_conflict); every other column keeps M213''s unchanged confirmed-column rule (beneficiary_column_mapping_required / _not_beneficiary / _mapping_conflict). (217) designatedQuantity must be a JSON string in the exact decimal grammar (designated_quantity_not_canonical), and every written link must pass the shared C5 quantity-lineage helper (need_line_quantity_lineage_unsafe, DETAIL session/source_record/need_line/reason). Every other M212 check is reproduced unchanged.';

-- ----------------------------------------------------------------------------
-- 9. Behaviour-only replacement of _phoenix_central_needs_assert_need_line_integrity_v1:
--    the M216 body plus the C5 lineage check of the touched link only (§11).
--    CREATE OR REPLACE keeps the function OID, so the four existing
--    assert_need_line_integrity constraint triggers pick it up unchanged.
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
  v_c5_links      uuid[] := ARRAY[]::uuid[];
  v_c5_link       uuid;
  v_c5_reason     text;
  v_c5_row        record;
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

  -- 217 ADDITION (C5 §9/§11) — the shared quantity-lineage helper judges ONLY
  -- the touched link(s), after every M212/M213/M216 clause above (they keep
  -- their precedence): a need_line_sources INSERT; an UPDATE that changes
  -- need_line_id, source_record_id, designated_quantity or applied_override_id;
  -- a need_lines UPDATE that moves plan_revision_id or organization_id (all of
  -- its links). A DELETE, a mapping event or a region event never runs it. The
  -- table and the operation are tested BEFORE any table-specific field is read.
  IF TG_TABLE_NAME = 'central_needs_need_line_sources' THEN
    IF TG_OP = 'INSERT' THEN
      v_c5_links := ARRAY[NEW.id];
    ELSIF TG_OP = 'UPDATE' THEN
      IF (NEW.need_line_id, NEW.source_record_id, NEW.designated_quantity, NEW.applied_override_id)
         IS DISTINCT FROM (OLD.need_line_id, OLD.source_record_id, OLD.designated_quantity, OLD.applied_override_id) THEN
        v_c5_links := ARRAY[NEW.id];
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'central_needs_need_lines' THEN
    IF TG_OP = 'UPDATE' THEN
      IF (NEW.plan_revision_id, NEW.organization_id) IS DISTINCT FROM (OLD.plan_revision_id, OLD.organization_id) THEN
        SELECT coalesce(array_agg(ls.id ORDER BY ls.id), ARRAY[]::uuid[])
          INTO v_c5_links
          FROM public.central_needs_need_line_sources ls
         WHERE ls.need_line_id = NEW.id;
      END IF;
    END IF;
  END IF;

  FOREACH v_c5_link IN ARRAY v_c5_links
  LOOP
    v_c5_reason := public._phoenix_central_needs_quantity_lineage_violation_v1(v_c5_link);
    IF v_c5_reason IS NOT NULL THEN
      SELECT r.import_session_id, ls.source_record_id, ls.need_line_id
        INTO v_c5_row
        FROM public.central_needs_need_line_sources ls
        JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
       WHERE ls.id = v_c5_link;
      RAISE EXCEPTION 'need_line_quantity_lineage_unsafe' USING ERRCODE = '23514',
        DETAIL = format('session=%s source_record=%s need_line=%s reason=%s',
                        v_c5_row.import_session_id, v_c5_row.source_record_id, v_c5_row.need_line_id, v_c5_reason),
        HINT = 'A need-line source link written outside the canonical RPC does not carry a safe quantity lineage.';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1()
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1() IS
  'CN-2B (212, extended by 213, 216 and C5 217): the deferred assertion that every need line a row change touched keeps mandatory source lineage, a designated-quantity sum equal to its approved quantity, canonical material agreement, no institution-level/warehouse-split mixture, (213) beneficiary-column-mapping agreement for every linked cell, and (216) beneficiary-REGION agreement for every linked cell in a region-governed column. (216) A region version insert or retirement re-checks the linked-cell rule for every linked cell of its (session, sheet); an in-use M213 row may be deleted only when its column is region-governed and every linked cell of it is covered by exactly one ACTIVE beneficiary region naming the line''s beneficiary (T5''). (217) After those clauses, the shared C5 quantity-lineage helper judges only the touched link(s) — a link INSERT, a link UPDATE of its line/record/quantity/override, or a line UPDATE of its revision/organization — with the same need_line_quantity_lineage_unsafe code and DETAIL as set_need_line. Runs at COMMIT, so it binds every write path rather than one RPC.';

-- ----------------------------------------------------------------------------
-- 10. Behaviour-only replacement of phoenix_central_needs_record_field_override:
--    serialized override chronology (§12).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_record_field_override(
  p_source_record_id   uuid,
  p_final_value        jsonb,
  p_override_reason    text,
  p_override_note      text DEFAULT NULL,
  p_override_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_record     public.central_needs_source_records%ROWTYPE;
  v_session    public.central_needs_import_sessions%ROWTYPE;
  v_revision   public.central_needs_plan_revisions%ROWTYPE;
  v_reason     text := NULLIF(btrim(p_override_reason), '');
  v_previous   jsonb;
  v_head_ts    timestamptz;
  v_row        public.central_needs_field_overrides%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_source_record_id IS NULL THEN
    RAISE EXCEPTION 'source_record_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'override_reason_required' USING ERRCODE = '23514',
      HINT = 'A business override must record why it was made.';
  END IF;

  -- No phantom field: the record must exist.
  SELECT * INTO v_record
    FROM public.central_needs_source_records
   WHERE id = p_source_record_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_record_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_session
    FROM public.central_needs_import_sessions
   WHERE id = v_record.import_session_id;

  v_actor_role := public._phoenix_central_needs_guard_v1(v_record.organization_id, 'central_needs.edit');
  v_revision   := public._phoenix_central_needs_load_revision_v1(v_session.plan_revision_id);
  PERFORM public._phoenix_central_needs_assert_draft_v1(v_session.plan_revision_id, v_revision.status);

  -- Chain from the latest prior override of THIS record...
  -- 217 (C5 §12): under the revision FOR UPDATE above, the head is the row
  -- ordered created_at DESC, id DESC — the same order every reader uses.
  SELECT o.final_value, o.created_at INTO v_previous, v_head_ts
    FROM public.central_needs_field_overrides o
   WHERE o.source_record_id = p_source_record_id
   ORDER BY o.created_at DESC, o.id DESC
   LIMIT 1;

  -- ...otherwise from the record's own immutable evidence, which is READ here
  -- and never written.
  IF NOT FOUND THEN
    v_previous := v_record.source_values;
  END IF;

  INSERT INTO public.central_needs_field_overrides (
    plan_revision_id, organization_id, source_record_id, target_entity, field_name,
    previous_value, final_value, override_reason, override_note, override_reference, actor_id,
    created_at
  ) VALUES (
    v_session.plan_revision_id, v_record.organization_id, p_source_record_id,
    v_record.target_entity, v_record.field_name,
    v_previous, p_final_value, v_reason,
    NULLIF(btrim(p_override_note), ''), NULLIF(btrim(p_override_reference), ''), v_actor,
    -- 217 (C5 §12): strictly newer than the current head, even when the head
    -- shares this transaction's start time or is future-dated.
    GREATEST(clock_timestamp(), COALESCE(v_head_ts + interval '1 microsecond', '-infinity'::timestamptz))
  )
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_record.organization_id, v_actor, v_actor_role,
    'central_needs.field_override.record', 'central_needs_field_override', v_row.id,
    v_record.target_entity,
    jsonb_build_object(
      'plan_revision_id', v_session.plan_revision_id,
      'import_session_id', v_record.import_session_id,
      'source_file_id', v_session.source_file_id,
      'source_record_id', p_source_record_id,
      'record_ordinal', v_record.record_ordinal,
      'target_entity', v_record.target_entity,
      'field_name', v_record.field_name,
      'override_reason', v_reason,
      'override_reference', NULLIF(btrim(p_override_reference), '')
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'override_id', v_row.id,
    'source_record_id', p_source_record_id,
    'record_ordinal', v_record.record_ordinal,
    'target_entity', v_record.target_entity, 'field_name', v_record.field_name,
    'previous_value', v_previous, 'final_value', p_final_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text) IS
  'CN-1B (210, C5 217): records a reasoned override of ONE immutable source record under its DRAFT revision''s FOR UPDATE lock. previous_value chains from the current head (created_at DESC, id DESC) or the record''s own evidence; the new row''s created_at is GREATEST(clock_timestamp(), head.created_at + 1 microsecond), so the override chronology is strictly serialized (217). Audited as central_needs.field_override.record.';

-- ----------------------------------------------------------------------------
-- 11. The approval fence (§16). A revision may BECOME approved — by INSERT or
--     by UPDATE from any other status — only in a transaction that already
--     wrote the canonical approval gate for it: same revision and owner, actor
--     = auth.uid(), payload.contract c5-v1, payload.txid = this transaction,
--     created_at = transaction_timestamp(). Only the canonical approve writes
--     it, after lifecycle A-E and A2 PASS.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_approval_gate_fence_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'approved' THEN
    IF TG_OP = 'UPDATE' THEN
      IF OLD.status IS NOT DISTINCT FROM 'approved' THEN
        RETURN NEW;
      END IF;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.audit_logs a
       WHERE a.action          = 'central_needs.plan_revision.approval_gate'
         AND a.entity_type     = 'central_needs_plan_revision'
         AND a.entity_id       = NEW.id
         AND a.organization_id = NEW.organization_id
         AND a.actor_id        = auth.uid()
         AND a.payload->>'contract' = 'c5-v1'
         AND a.payload->>'txid'     = txid_current()::text
         AND a.created_at      = transaction_timestamp()
    ) THEN
      RAISE EXCEPTION 'central_needs_approval_gate_missing' USING ERRCODE = '23514',
        DETAIL = format('revision=%s', NEW.id),
        HINT = 'A revision becomes approved only through phoenix_central_needs_approve_revision.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_approval_gate_fence_v1() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._phoenix_central_needs_approval_gate_fence_v1() IS
  'C5 (217) internal: the approval fence. BEFORE INSERT OR UPDATE on central_needs_plan_revisions, a row becoming approved requires the canonical same-transaction approval gate (central_needs_approval_gate_missing otherwise). Not client-callable.';

-- ----------------------------------------------------------------------------
-- 12. Behaviour-only replacement of phoenix_central_needs_approve_revision (§3/§4/§16).
--    ACL-NEUTRAL: same signature, CREATE OR REPLACE only, no GRANT/REVOKE.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_approve_revision(
  p_plan_revision_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_revision    public.central_needs_plan_revisions%ROWTYPE;
  v_plan        public.central_needs_plans%ROWTYPE;
  v_latest      public.central_needs_plan_revisions%ROWTYPE;
  v_predecessor public.central_needs_plan_revisions%ROWTYPE;
  v_approved    integer;
  v_rows        integer;
  -- 217 (C5 §3/§4)
  v_line        record;
  v_ben         record;
  v_wh          record;
  v_reason      text;
  v_blocker     text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_revision_id IS NULL THEN
    RAISE EXCEPTION 'plan_revision_id_required' USING ERRCODE = '23514';
  END IF;

  -- Unlocked resolution: only the organization is needed to authorize, and the
  -- family lock below is always taken in the same order by every writer.
  SELECT * INTO v_revision
    FROM public.central_needs_plan_revisions
   WHERE id = p_plan_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.approve');

  -- 217 (C5 §3) — the plan owner organization FOR SHARE, and live, BEFORE the
  -- family lock: the one order every approver takes.
  PERFORM 1 FROM public.organizations WHERE id = v_revision.organization_id FOR SHARE;
  PERFORM public._phoenix_central_needs_assert_org_live_v1(v_revision.organization_id);

  SELECT * INTO v_plan FROM public.central_needs_plans WHERE id = v_revision.plan_id;
  v_plan := public._phoenix_central_needs_lock_plan_family_v1(v_plan.organization_id, v_plan.plan_year);

  -- Re-read under the lock: this is the state the decision is made on.
  SELECT * INTO v_revision
    FROM public.central_needs_plan_revisions
   WHERE id = p_plan_revision_id;

  IF v_revision.status = 'approved' THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'plan_revision_id', p_plan_revision_id, 'status', 'approved'
    );
  END IF;

  IF v_revision.status <> 'submitted' THEN
    RAISE EXCEPTION 'plan_revision_not_submitted' USING ERRCODE = '23514',
      DETAIL = format('revision=%s status=%s', p_plan_revision_id, v_revision.status),
      HINT = 'Only a submitted revision can be approved.';
  END IF;

  SELECT * INTO v_latest
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id
   ORDER BY revision_number DESC
   LIMIT 1;
  IF v_latest.id <> v_revision.id THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('submitted revision=%s (revision %s) is not the newest revision of plan=%s (newest %s)',
                      v_revision.id, v_revision.revision_number, v_plan.id, v_latest.revision_number);
  END IF;

  SELECT count(*) INTO v_approved
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id AND status = 'approved';
  IF v_approved > 1 THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('plan=%s holds %s approved revisions', v_plan.id, v_approved);
  END IF;

  -- 217 (C5 §3) — E: identify the single effective predecessor ONLY. Nothing is
  -- mutated before A2 PASS.
  IF v_approved = 1 THEN
    SELECT * INTO v_predecessor
      FROM public.central_needs_plan_revisions
     WHERE plan_id = v_plan.id AND status = 'approved';
  END IF;

  -- 217 (C5 §3) — only after A-E: the distinct beneficiary organizations, then
  -- the distinct non-null target warehouses, each FOR SHARE ORDER BY id, so the
  -- eligibility judged below cannot change until this transaction ends.
  PERFORM 1
    FROM public.organizations o
   WHERE o.id IN (SELECT n.beneficiary_organization_id
                    FROM public.central_needs_need_lines n
                   WHERE n.plan_revision_id = p_plan_revision_id)
   ORDER BY o.id
   FOR SHARE;
  PERFORM 1
    FROM public.warehouses w
   WHERE w.id IN (SELECT n.target_warehouse_id
                    FROM public.central_needs_need_lines n
                   WHERE n.plan_revision_id = p_plan_revision_id
                     AND n.target_warehouse_id IS NOT NULL)
   ORDER BY w.id
   FOR SHARE;

  -- 217 (C5 §4) — A2: approval-time eligibility. Lines by id ASC; for each,
  -- the beneficiary before the warehouse; inactive wins over archived and
  -- not_owned over not_active. The first failure refuses the approval with
  -- the readiness blocker it corresponds to; nothing has been written yet.
  FOR v_line IN
    SELECT n.id, n.beneficiary_organization_id, n.target_warehouse_id
      FROM public.central_needs_need_lines n
     WHERE n.plan_revision_id = p_plan_revision_id
     ORDER BY n.id
  LOOP
    v_reason := NULL;
    SELECT o.organization_kind, o.status, o.archived_at INTO v_ben
      FROM public.organizations o
     WHERE o.id = v_line.beneficiary_organization_id;
    IF NOT FOUND THEN
      v_reason := 'not_found';
    ELSIF v_ben.organization_kind IS DISTINCT FROM 'care_institution' THEN
      v_reason := 'not_care_institution';
    ELSIF v_ben.status IS DISTINCT FROM 'active' THEN
      v_reason := 'inactive';
    ELSIF v_ben.archived_at IS NOT NULL THEN
      v_reason := 'archived';
    END IF;
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION 'central_needs_approval_eligibility_changed' USING ERRCODE = '23514',
        DETAIL = format('blocker=need_line_beneficiary_ineligible need_line=%s beneficiary=%s reason=%s',
                        v_line.id, v_line.beneficiary_organization_id, v_reason),
        HINT = 'A beneficiary became ineligible after submission. Reject the revision and correct it through a new draft.';
    END IF;

    IF v_line.target_warehouse_id IS NOT NULL THEN
      SELECT w.organization_id, w.status INTO v_wh
        FROM public.warehouses w
       WHERE w.id = v_line.target_warehouse_id;
      IF NOT FOUND THEN
        v_reason := 'not_found';
        v_blocker := 'need_line_warehouse_org_mismatch';
      ELSIF v_wh.organization_id IS DISTINCT FROM v_line.beneficiary_organization_id THEN
        v_reason := 'not_owned';
        v_blocker := 'need_line_warehouse_org_mismatch';
      ELSIF v_wh.status IS DISTINCT FROM 'active' THEN
        v_reason := 'not_active';
        v_blocker := 'need_line_target_warehouse_not_active';
      END IF;
      IF v_reason IS NOT NULL THEN
        RAISE EXCEPTION 'central_needs_approval_eligibility_changed' USING ERRCODE = '23514',
          DETAIL = format('blocker=%s need_line=%s beneficiary=%s warehouse=%s reason=%s',
                          v_blocker, v_line.id, v_line.beneficiary_organization_id,
                          v_line.target_warehouse_id, v_reason),
          HINT = 'A target warehouse became ineligible after submission. Reject the revision and correct it through a new draft.';
      END IF;
    END IF;
  END LOOP;

  -- 217 (C5 §16) — the approval gate, written only after lifecycle A-E and A2
  -- PASS, in THIS transaction: the fence on plan_revisions admits the APPROVED
  -- transition below only against it (actor = auth.uid(), txid = this txid,
  -- created_at = transaction_timestamp() by default).
  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.approval_gate', 'central_needs_plan_revision', p_plan_revision_id,
    format('revision %s', v_revision.revision_number),
    jsonb_build_object(
      'contract', 'c5-v1',
      'txid', txid_current()::text,
      'plan_id', v_plan.id,
      'revision_number', v_revision.revision_number
    )
  );

  IF v_predecessor.id IS NOT NULL THEN
    -- APPROVED -> SUPERSEDED keeps approved_by/approved_at (M209's pair CHECK
    -- allows exactly that), so the historical approval stays traceable.
    UPDATE public.central_needs_plan_revisions
       SET status = 'superseded'
     WHERE id = v_predecessor.id AND status = 'approved';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
        DETAIL = format('predecessor=%s could not be superseded', v_predecessor.id);
    END IF;
  END IF;

  UPDATE public.central_needs_plan_revisions
     SET status = 'approved', approved_by = v_actor, approved_at = now()
   WHERE id = p_plan_revision_id AND status = 'submitted';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('revision=%s could not be approved', p_plan_revision_id);
  END IF;

  -- Postcondition: exactly one effective revision. Anything else rolls the
  -- whole switch back.
  SELECT count(*) INTO v_approved
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id AND status = 'approved';
  IF v_approved <> 1 THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('plan=%s would hold %s approved revisions', v_plan.id, v_approved);
  END IF;

  IF v_predecessor.id IS NOT NULL THEN
    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_revision.organization_id, v_actor, v_actor_role,
      'central_needs.plan_revision.supersede', 'central_needs_plan_revision', v_predecessor.id,
      format('plan %s revision %s', v_plan.plan_year, v_predecessor.revision_number),
      jsonb_build_object(
        'plan_id', v_plan.id,
        'plan_year', v_plan.plan_year,
        'revision_number', v_predecessor.revision_number,
        'from_status', 'approved', 'to_status', 'superseded',
        'superseded_by_revision_id', p_plan_revision_id,
        'superseded_by_revision_number', v_revision.revision_number
      )
    );
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.approve', 'central_needs_plan_revision', p_plan_revision_id,
    format('revision %s', v_revision.revision_number),
    jsonb_build_object(
      'plan_id', v_plan.id,
      'plan_year', v_plan.plan_year,
      'revision_number', v_revision.revision_number,
      'from_status', 'submitted', 'to_status', 'approved',
      'predecessor_revision_id', v_predecessor.id,
      'predecessor_revision_number', v_predecessor.revision_number,
      'predecessor_from_status', CASE WHEN v_predecessor.id IS NULL THEN NULL ELSE 'approved' END,
      'predecessor_to_status', CASE WHEN v_predecessor.id IS NULL THEN NULL ELSE 'superseded' END,
      -- 217 (C5 §2.5/§16): correlates this approval with its same-transaction gate.
      'approval_gate_txid', txid_current()::text
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'plan_revision_id', p_plan_revision_id, 'status', 'approved',
    'plan_id', v_plan.id, 'revision_number', v_revision.revision_number,
    'superseded_revision_id', v_predecessor.id
  );
END;
$$;

-- ACL-NEUTRAL (C5 §2.6/§22): no GRANT/REVOKE on this function here; CREATE OR
-- REPLACE keeps its existing privileges exactly.

COMMENT ON FUNCTION public.phoenix_central_needs_approve_revision(uuid) IS
  'C2 (215, C5 217): approves a submitted revision (central_needs.approve). Guard order unchanged; then the owner organization FOR SHARE and live, the family lock, lifecycle A-E (the predecessor is only identified), the distinct beneficiary organizations then the distinct target warehouses FOR SHARE ORDER BY id, and A2 approval-time eligibility (central_needs_approval_eligibility_changed with the readiness blocker, ids and reason). Only then the same-transaction approval gate (central_needs.plan_revision.approval_gate, required by the plan_revisions fence) and the atomic switch: predecessor APPROVED -> SUPERSEDED, target SUBMITTED -> APPROVED, both audited, the approve audit carrying approval_gate_txid. Ambiguous state fails closed and is never repaired; lock and serialization errors are never translated.';

-- ----------------------------------------------------------------------------
-- 13. The ONE new trigger (§16): BEFORE INSERT OR UPDATE, no column list, so
--     no write path can reach the approved state without the gate.
-- ----------------------------------------------------------------------------
CREATE TRIGGER central_needs_plan_revisions_c5_approval_gate
  BEFORE INSERT OR UPDATE ON public.central_needs_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_central_needs_approval_gate_fence_v1();

COMMENT ON TRIGGER central_needs_plan_revisions_c5_approval_gate ON public.central_needs_plan_revisions IS
  'C5 (217): the approval fence — a revision becomes approved only with the canonical same-transaction approval gate.';

-- ----------------------------------------------------------------------------
-- 14. VERIFY — catalog-only, plus pure classifier probes. Fail the migration
--     rather than ship a half-applied contract. Asserts NOTHING about the final
--     client EXECUTE grants of submit/approve/reject: only that M217 left them
--     exactly as it found them.
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_sig  text;
  v_code text;
  v_def  text;
  n      bigint;
BEGIN
  -- The classifier.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public._phoenix_central_needs_review_numeric_class_v1(jsonb)'::regprocedure
       AND p.provolatile = 'i' AND NOT p.proisstrict AND NOT p.prosecdef
       AND p.prorettype = 'text'::regtype
       AND 'search_path=public, pg_temp' = ANY (p.proconfig)
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): the classifier attributes are wrong';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public._phoenix_central_needs_review_numeric_class_v1(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public._phoenix_central_needs_review_numeric_class_v1(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._phoenix_central_needs_review_numeric_class_v1(jsonb)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = 'public._phoenix_central_needs_review_numeric_class_v1(jsonb)'::regprocedure AND a.grantee = 0) THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): the classifier grants are wrong';
  END IF;

  -- Internal helpers: SECURITY DEFINER, pinned search_path, no client EXECUTE.
  FOREACH v_sig IN ARRAY ARRAY[
    'public._phoenix_central_needs_quantity_lineage_violation_v1(uuid)',
    'public._phoenix_central_needs_approval_gate_fence_v1()'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)
                    AND p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig)) THEN
      RAISE EXCEPTION 'VERIFY FAILED (217): % is missing or not a pinned SECURITY DEFINER', v_sig;
    END IF;
    IF has_function_privilege('anon', v_sig, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig, 'EXECUTE')
       OR has_function_privilege('service_role', v_sig, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = to_regprocedure(v_sig) AND a.grantee = 0) THEN
      RAISE EXCEPTION 'VERIFY FAILED (217): internal % is client-callable', v_sig;
    END IF;
  END LOOP;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public._phoenix_central_needs_quantity_lineage_violation_v1(uuid)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): the lineage helper must be STABLE';
  END IF;

  -- The future-write CHECK: present, NOT VALID, on source_records, classifier-backed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conname = 'central_needs_source_records_c5_value_contract'
       AND c.conrelid = 'public.central_needs_source_records'::regclass
       AND c.contype = 'c' AND NOT c.convalidated
       AND position('_phoenix_central_needs_review_numeric_class_v1' IN pg_get_constraintdef(c.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): the NOT VALID source-value CHECK is missing or wrong';
  END IF;

  -- The fence: exactly one new trigger, BEFORE ROW INSERT OR UPDATE, no column
  -- list, enabled, bound to the fence function; plan_revisions carries exactly
  -- set_updated_at and the fence.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'central_needs_plan_revisions_c5_approval_gate'
       AND t.tgrelid = 'public.central_needs_plan_revisions'::regclass
       AND t.tgfoid = 'public._phoenix_central_needs_approval_gate_fence_v1()'::regprocedure
       AND t.tgtype = 23          -- ROW(1) | BEFORE(2) | INSERT(4) | UPDATE(16)
       AND cardinality(t.tgattr::int2[]) = 0   -- no column list
       AND t.tgenabled = 'O' AND t.tgconstraint = 0 AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): the approval fence trigger is missing or wrong';
  END IF;
  IF (SELECT array_agg(t.tgname::text ORDER BY t.tgname) FROM pg_trigger t
       WHERE t.tgrelid = 'public.central_needs_plan_revisions'::regclass AND NOT t.tgisinternal)
     IS DISTINCT FROM ARRAY['central_needs_plan_revisions_c5_approval_gate', 'set_updated_at'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): central_needs_plan_revisions must carry exactly set_updated_at and the fence';
  END IF;

  -- Replaced functions: identical identity, SECURITY properties, and the C5 needles.
  FOREACH v_sig IN ARRAY ARRAY[
    'public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid)',
    'public._phoenix_central_needs_review_blockers_v1(uuid)',
    'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)',
    'public._phoenix_central_needs_assert_need_line_integrity_v1()',
    'public.phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text)',
    'public.phoenix_central_needs_approve_revision(uuid)'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)
                    AND p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig)) THEN
      RAISE EXCEPTION 'VERIFY FAILED (217): % is missing or not a pinned SECURITY DEFINER', v_sig;
    END IF;
  END LOOP;

  v_def := pg_get_functiondef('public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid)'::regprocedure);
  IF position('beneficiary_organization_archived' IN v_def) = 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): the beneficiary helper lacks the archived refusal';
  END IF;

  v_def := pg_get_functiondef('public._phoenix_central_needs_review_blockers_v1(uuid)'::regprocedure);
  FOREACH v_code IN ARRAY ARRAY[
    '''source_cell_value_contract_invalid''', '''need_line_quantity_lineage_unsafe''',
    '_phoenix_central_needs_review_numeric_class_v1', '_phoenix_central_needs_quantity_lineage_violation_v1',
    'reason=not_owned', 'reason=not_active', '''beneficiary_column_review_required''',
    '''beneficiary_region_geometry_invalid'''
  ] LOOP
    IF position(v_code IN v_def) = 0 THEN
      RAISE EXCEPTION 'VERIFY FAILED (217): the blockers function lacks %', v_code;
    END IF;
  END LOOP;
  IF position('''valueType'' = ''number''' IN v_def) > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): the blockers function still has an independent valueType completeness test';
  END IF;

  v_def := pg_get_functiondef('public.phoenix_central_needs_list_beneficiary_columns(uuid)'::regprocedure);
  IF position('_phoenix_central_needs_review_numeric_class_v1' IN v_def) = 0
     OR position('''valueType'' = ''number''' IN v_def) > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): the beneficiary-column list is not classifier-backed';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.phoenix_central_needs_list_beneficiary_columns(uuid)'::regprocedure)
     OR pg_get_function_result('public.phoenix_central_needs_list_beneficiary_columns(uuid)'::regprocedure)
        <> 'TABLE(import_session_id uuid, original_filename text, archive_entry_path text, sheet_index integer, sheet_name text, column_index integer, source_field_name text, numeric_value_count bigint, zero_value_count bigint, nonzero_numeric_count bigint, mapping_id uuid, column_decision text, beneficiary_organization_id uuid, mapping_reason text, mapped_at timestamp with time zone, mapped_row_numeric_count bigint, review_required boolean)' THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): list_beneficiary_columns changed shape or security';
  END IF;

  v_def := pg_get_functiondef('public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)'::regprocedure);
  FOREACH v_code IN ARRAY ARRAY[
    '''designated_quantity_not_canonical''', '''need_line_quantity_lineage_unsafe''',
    '_phoenix_central_needs_quantity_lineage_violation_v1', '''source_link_requires_designated_quantity''',
    '''beneficiary_region_required''', '_phoenix_central_needs_resolve_column_mapping_v1'
  ] LOOP
    IF position(v_code IN v_def) = 0 THEN
      RAISE EXCEPTION 'VERIFY FAILED (217): set_need_line lacks %', v_code;
    END IF;
  END LOOP;

  v_def := pg_get_functiondef('public._phoenix_central_needs_assert_need_line_integrity_v1()'::regprocedure);
  FOREACH v_code IN ARRAY ARRAY[
    '''need_line_quantity_lineage_unsafe''', '_phoenix_central_needs_quantity_lineage_violation_v1',
    '''need_line_requires_source_lineage''', '''beneficiary_region_mapping_conflict''',
    '_phoenix_central_needs_region_column_covered_v1'
  ] LOOP
    IF position(v_code IN v_def) = 0 THEN
      RAISE EXCEPTION 'VERIFY FAILED (217): the integrity function lacks %', v_code;
    END IF;
  END LOOP;

  v_def := pg_get_functiondef('public.phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text)'::regprocedure);
  IF position('GREATEST(clock_timestamp()' IN v_def) = 0 OR position('ORDER BY o.created_at DESC, o.id DESC' IN v_def) = 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): the override chronology is not serialized';
  END IF;

  v_def := pg_get_functiondef('public.phoenix_central_needs_approve_revision(uuid)'::regprocedure);
  FOREACH v_code IN ARRAY ARRAY[
    '''central_needs.plan_revision.approval_gate''', '''approval_gate_txid''',
    '''central_needs_approval_eligibility_changed''', 'FOR SHARE',
    '_phoenix_central_needs_lock_plan_family_v1', '''superseded''', '''plan_revision_not_submitted'''
  ] LOOP
    IF position(v_code IN v_def) = 0 THEN
      RAISE EXCEPTION 'VERIFY FAILED (217): approve lacks %', v_code;
    END IF;
  END LOOP;

  -- House grants on the replaced client RPCs that are NOT lifecycle RPCs.
  FOREACH v_sig IN ARRAY ARRAY[
    'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)',
    'public.phoenix_central_needs_list_beneficiary_columns(uuid)',
    'public.phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text)'
  ] LOOP
    IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
       OR has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (217): % grants changed', v_sig;
    END IF;
  END LOOP;

  -- Exact expected overloads: one definition for every C5-touched name.
  FOREACH v_code IN ARRAY ARRAY[
    '_phoenix_central_needs_review_numeric_class_v1', '_phoenix_central_needs_quantity_lineage_violation_v1',
    '_phoenix_central_needs_approval_gate_fence_v1', '_phoenix_central_needs_assert_beneficiary_v1',
    '_phoenix_central_needs_review_blockers_v1', 'phoenix_central_needs_list_beneficiary_columns',
    'phoenix_central_needs_set_need_line', '_phoenix_central_needs_assert_need_line_integrity_v1',
    'phoenix_central_needs_record_field_override', 'phoenix_central_needs_approve_revision',
    'phoenix_central_needs_submit_revision', 'phoenix_central_needs_reject_revision'
  ] LOOP
    SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = v_code;
    IF n <> 1 THEN
      RAISE EXCEPTION 'VERIFY FAILED (217): % must have exactly one overload (got %)', v_code, n;
    END IF;
  END LOOP;

  -- ACL-NEUTRALITY (§2.6/§22): the lifecycle RPCs' privileges are exactly what
  -- they were before M217 — whatever that was (frozen or not).
  IF (SELECT string_agg(p.oid::regprocedure::text || '=' || coalesce(p.proacl::text, '(default)'), ';' ORDER BY p.oid::regprocedure::text)
        FROM pg_proc p
       WHERE p.oid IN ('public.phoenix_central_needs_submit_revision(uuid)'::regprocedure,
                       'public.phoenix_central_needs_approve_revision(uuid)'::regprocedure,
                       'public.phoenix_central_needs_reject_revision(uuid, text)'::regprocedure))
     IS DISTINCT FROM current_setting('phoenix_m217.lifecycle_acl', true) THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): submit/approve/reject privileges changed';
  END IF;

  -- Authenticated users have no direct INSERT on audit_logs (table or column):
  -- nobody but a SECURITY DEFINER path can write an approval gate (§16).
  IF has_table_privilege('authenticated', 'public.audit_logs', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.audit_logs', 'INSERT')
     OR has_table_privilege('anon', 'public.audit_logs', 'INSERT')
     OR has_any_column_privilege('anon', 'public.audit_logs', 'INSERT') THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): a client role can insert audit_logs rows directly';
  END IF;

  -- Only readiness and submit call the blockers function; readiness stays VOLATILE.
  IF (SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public' AND p.prokind = 'f'
         AND p.proname <> '_phoenix_central_needs_review_blockers_v1'
         AND position('_phoenix_central_needs_review_blockers_v1' IN pg_get_functiondef(p.oid)) > 0)
     IS DISTINCT FROM ARRAY['phoenix_central_needs_review_readiness', 'phoenix_central_needs_submit_revision'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): only review_readiness and submit may call the blockers function';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.phoenix_central_needs_review_readiness(uuid)'::regprocedure) <> 'v' THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): review_readiness must stay VOLATILE';
  END IF;

  -- No data change: every plan revision keeps its status.
  IF (SELECT coalesce(md5(string_agg(id::text || ':' || status, ',' ORDER BY id)), 'empty')
        FROM public.central_needs_plan_revisions)
     IS DISTINCT FROM current_setting('phoenix_m217.revision_status', true) THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): a plan revision status changed';
  END IF;

  -- §1 lock budget, proven from pg_locks of THIS transaction before COMMIT:
  -- source_records ACCESS EXCLUSIVE and plan_revisions EXCLUSIVE (plus the
  -- SHARE ROW EXCLUSIVE of the one CREATE TRIGGER); every other Phoenix
  -- application relation ACCESS SHARE only; no advisory or tuple lock.
  SELECT count(*) INTO n
    FROM pg_locks l
    JOIN pg_class c ON c.oid = l.relation
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE l.pid = pg_backend_pid()
     AND l.locktype = 'relation'
     AND ns.nspname = 'public'
     AND l.mode <> 'AccessShareLock'
     AND NOT (c.relname = 'central_needs_source_records' AND l.mode = 'AccessExclusiveLock')
     AND NOT (c.relname = 'central_needs_plan_revisions' AND l.mode IN ('ExclusiveLock', 'ShareRowExclusiveLock'));
  IF n > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): % Phoenix relation lock(s) outside the §1 budget', n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation'
                  AND l.relation = 'public.central_needs_source_records'::regclass AND l.mode = 'AccessExclusiveLock')
     OR NOT EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation'
                  AND l.relation = 'public.central_needs_plan_revisions'::regclass AND l.mode = 'ExclusiveLock') THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): the §1 activation lock pair is not held';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = pg_backend_pid() AND l.locktype IN ('advisory', 'tuple')) THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): an advisory or tuple lock is held';
  END IF;

  -- Pure classifier probes (§5).
  IF public._phoenix_central_needs_review_numeric_class_v1(NULL) <> 'invalid_evidence'
     OR public._phoenix_central_needs_review_numeric_class_v1('{"value": 25, "valueType": "number"}') <> 'native_number'
     OR public._phoenix_central_needs_review_numeric_class_v1('{"value": "25", "valueType": "string"}') <> 'canonical_integer_text'
     OR public._phoenix_central_needs_review_numeric_class_v1('{"value": "025", "valueType": "string"}') <> 'ambiguous_numeric_text'
     OR public._phoenix_central_needs_review_numeric_class_v1('{"value": "Infinity", "valueType": "string"}') <> 'ambiguous_numeric_text'
     OR public._phoenix_central_needs_review_numeric_class_v1('{"value": "box", "valueType": "string"}') <> 'not_numeric'
     OR public._phoenix_central_needs_review_numeric_class_v1('{"value": null, "valueType": "string"}') <> 'not_numeric'
     OR public._phoenix_central_needs_review_numeric_class_v1('{"value": null, "valueType": "number"}') <> 'invalid_evidence'
     OR public._phoenix_central_needs_review_numeric_class_v1('{"value": 25}') <> 'invalid_evidence'
     OR public._phoenix_central_needs_review_numeric_class_v1('{"valueType": "number"}') <> 'invalid_evidence'
     OR public._phoenix_central_needs_review_numeric_class_v1('[25]') <> 'invalid_evidence' THEN
    RAISE EXCEPTION 'VERIFY FAILED (217): the classifier misbehaves';
  END IF;
END
$verify$;

COMMIT;
