-- ============================================================================
-- 211 — CN-2B: trusted import batches, explicit mapping dispositions, and
--       server-enforced review completeness.
--
-- WHY THIS MIGRATION EXISTS
--   M210 shipped the workflow RPC layer, but its submit gate enforces exactly
--   one rule: "at least one import session reached status = 'completed'". The
--   CN-2B entry gate established that this is not sufficient, for three
--   independent reasons:
--
--   (A) UNMAPPED EVIDENCE COULD BE SUBMITTED. CN-2A's parser emits one
--       target_entity per spreadsheet ROW (`sheet:{i}:row:{r}`), positionally.
--       Nothing in the evidence distinguishes a material row from a subtotal,
--       a footer, a note or a continuation row — deciding that requires
--       per-workbook business semantics that this system deliberately does not
--       possess (see contract.ts, "CONTINUATION ROWS — status: DEFERRED").
--       So the server cannot be asked to infer which rows *need* mapping.
--       It CAN, however, require that a human made an explicit decision about
--       every row. That is what `decision IN ('mapped','not_applicable')` is:
--       the reviewer supplies the business judgement, the database enforces
--       only that the judgement exists and is internally consistent.
--       Nothing here ever infers a disposition from workbook structure.
--
--   (B) A CRASHED ZIP COULD LEAVE UNPROVABLE HISTORY. A ZIP archive can carry
--       many accepted workbook entries, each of which becomes its own source
--       file and its own M210 import session (entry hashes differ from the
--       container hash — see section 3). If the trusted worker died after
--       finalizing 3 of 5 entries, the database would hold three completed
--       sessions and no way to know that two more were supposed to exist.
--       A relational batch manifest closes that: a completed session that is
--       not a member of a fully registered batch can never make a revision
--       submittable, so a partial archive stays fail-closed until it is either
--       completed or abandoned.
--
--   (C) ABANDONED ATTEMPTS COULD LINGER. M210's start_import_session returns
--       whatever session already exists for a (revision, file hash) pair, with
--       no state discrimination, so a permanently stuck 'processing' attempt
--       had no terminal path and did not block submission. Section 8 gives
--       retry explicit semantics and section 7 gives an authorized human a
--       reasoned way to close an attempt out.
--
-- WHAT THIS MIGRATION IS NOT
--   * Not a second mapping ledger. central_needs_record_mappings is EVOLVED
--     in place; phoenix_central_needs_set_record_mapping keeps its exact M210
--     signature and remains the 'mapped' case.
--   * Not a parallel authorization system. Every client write still runs
--     through _phoenix_central_needs_guard_v1, i.e. through
--     public.phoenix_status_center_authorized.
--   * Not a new permission surface. No permission key is created; there is
--     still deliberately NO central_needs.send. Physical send remains
--     warehouse_transfer.send.
--   * Not a backfill. Section 0 fails closed rather than inventing lineage.
--
-- M209 and M210 are not edited. Every change here is additive or an explicit
-- CREATE OR REPLACE of an M210 function whose signature is preserved.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Preconditions — fail closed if the M209/M210 surface is not exactly as
--    expected, or if pre-M211 data exists whose lineage cannot be derived.
-- ----------------------------------------------------------------------------
DO $precondition$
DECLARE
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files',
    'central_needs_import_sessions', 'central_needs_source_records',
    'central_needs_field_overrides', 'central_needs_record_mappings'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '211_precondition_failed: required table % is absent (M209/M210 not applied)', t;
    END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY[
    'public.phoenix_central_needs_start_import_session(uuid, text, text, text, jsonb, bigint, text)',
    'public.phoenix_central_needs_submit_revision(uuid)',
    'public.phoenix_central_needs_set_record_mapping(uuid, text, uuid)',
    'public.phoenix_central_needs_apply_authoritative_replay(uuid, text, jsonb, jsonb)',
    'public._phoenix_central_needs_guard_v1(uuid, text)',
    'public._phoenix_central_needs_load_revision_v1(uuid)',
    'public._phoenix_central_needs_assert_draft_v1(uuid, text)',
    'public._phoenix_central_needs_assert_org_live_v1(uuid)',
    'public._phoenix_central_needs_payload_digest_v1(jsonb)'
  ] LOOP
    IF to_regprocedure(t) IS NULL THEN
      RAISE EXCEPTION '211_precondition_failed: M210 function % is absent', t;
    END IF;
  END LOOP;

  IF to_regclass('public.central_needs_import_batches') IS NOT NULL THEN
    RAISE EXCEPTION '211_precondition_failed: central_needs_import_batches already exists';
  END IF;
  IF to_regclass('public.central_needs_import_batch_entries') IS NOT NULL THEN
    RAISE EXCEPTION '211_precondition_failed: central_needs_import_batch_entries already exists';
  END IF;

  FOREACH t IN ARRAY ARRAY['decision', 'decision_reason', 'decided_by', 'decided_at'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'central_needs_record_mappings' AND column_name = t
    ) THEN
      RAISE EXCEPTION '211_precondition_failed: central_needs_record_mappings.% already exists', t;
    END IF;
  END LOOP;

  -- FAIL CLOSED ON UNEXPECTED PRE-M211 DATA.
  --
  -- An existing mapping row IS deterministically migratable: M210's only
  -- writer requires central_item_id NOT NULL, so such a row is unambiguously
  -- decision = 'mapped'. Section 1 migrates those with an explicit DEFAULT
  -- that is then dropped.
  --
  -- A completed import session is NOT migratable. Section 3 makes batch
  -- membership a submission precondition, and there is no honest way to
  -- reconstruct which container a pre-M211 session arrived in, in what order,
  -- or alongside which sibling entries. Inventing a single-entry batch for it
  -- would fabricate exactly the provenance this migration exists to prove.
  SELECT count(*) INTO n FROM public.central_needs_import_sessions WHERE status = 'completed';
  IF n > 0 THEN
    RAISE EXCEPTION '211_precondition_failed: % completed pre-M211 import session(s) exist; trusted batch lineage cannot be reconstructed. Owner review required — do not backfill.', n;
  END IF;
END;
$precondition$;

-- ----------------------------------------------------------------------------
-- 1. Explicit human disposition on the existing mapping surface.
--
--    central_item_id becomes nullable ONLY so that 'not_applicable' can be
--    represented; the paired CHECK makes the two cases mutually exclusive and
--    individually complete, so nullability can never mean "unknown".
-- ----------------------------------------------------------------------------
ALTER TABLE public.central_needs_record_mappings
  ALTER COLUMN central_item_id DROP NOT NULL;

ALTER TABLE public.central_needs_record_mappings
  ADD COLUMN decision        text NOT NULL DEFAULT 'mapped',
  ADD COLUMN decision_reason text,
  ADD COLUMN decided_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN decided_at      timestamptz NOT NULL DEFAULT now();

-- The DEFAULT existed only to migrate pre-M211 rows (which are necessarily
-- 'mapped', see section 0). Every future write must state its decision.
ALTER TABLE public.central_needs_record_mappings
  ALTER COLUMN decision DROP DEFAULT;

ALTER TABLE public.central_needs_record_mappings
  ADD CONSTRAINT central_needs_record_mappings_decision_vocab_chk
    CHECK (decision IN ('mapped', 'not_applicable')),
  ADD CONSTRAINT central_needs_record_mappings_disposition_chk
    CHECK (
      (
        decision = 'mapped'
        AND central_item_id IS NOT NULL
        AND (decision_reason IS NULL OR btrim(decision_reason) <> '')
      )
      OR
      (
        decision = 'not_applicable'
        AND central_item_id IS NULL
        AND decision_reason IS NOT NULL
        AND btrim(decision_reason) <> ''
      )
    );

COMMENT ON COLUMN public.central_needs_record_mappings.decision IS
  'CN-2B: the explicit human disposition of one imported target_entity. ''mapped'' carries a central_item_id; ''not_applicable'' carries a required reason and no item. NEVER inferred from workbook structure — the reviewer decides whether a row is a material, a subtotal, a note, a footer or a continuation.';
COMMENT ON COLUMN public.central_needs_record_mappings.decision_reason IS
  'CN-2B: mandatory free-text justification when decision = ''not_applicable''; optional note when ''mapped''. Internal review rationale — never exposed to institution/outlet users.';

-- ----------------------------------------------------------------------------
-- 2. Composite identity so batch membership is declaratively, not
--    procedurally, bound to one revision and one organization.
-- ----------------------------------------------------------------------------
ALTER TABLE public.central_needs_import_sessions
  ADD CONSTRAINT central_needs_import_sessions_id_revision_org_key
    UNIQUE (id, plan_revision_id, organization_id);

-- ----------------------------------------------------------------------------
-- 3. The trusted batch manifest.
--
--    CONTAINER HASH IS NOT AN ENTRY HASH. For a ZIP the container_sha256 is
--    the archive's own fingerprint; each accepted entry keeps its own
--    InputFingerprint.sha256, which is what M210 keys the source file and
--    import session on. Conflating the two would make an archive
--    indistinguishable from its first member, so they are separate columns on
--    separate tables and the VERIFY block asserts the batch table carries no
--    entry-level hash of its own.
-- ----------------------------------------------------------------------------
CREATE TABLE public.central_needs_import_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_revision_id      uuid NOT NULL,
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  container_kind        text NOT NULL CHECK (container_kind IN ('file', 'zip')),
  -- Retained as METADATA only. It is never a storage path component; see
  -- storage_locator and the CN-2B upload service.
  container_filename    text NOT NULL CHECK (btrim(container_filename) <> ''),
  container_sha256      text NOT NULL CHECK (container_sha256 ~ '^[0-9a-f]{64}$'),
  container_byte_size   bigint CHECK (container_byte_size IS NULL OR container_byte_size >= 0),
  -- Opaque, server-generated, content-addressed locator for the immutable
  -- permanent source object. Never user-controlled, never a filename.
  storage_locator       text NOT NULL CHECK (btrim(storage_locator) <> ''),
  accepted_entry_count  integer NOT NULL CHECK (accepted_entry_count > 0),
  excluded_entry_count  integer NOT NULL DEFAULT 0 CHECK (excluded_entry_count >= 0),
  reconciliation        jsonb,
  parser_identity       jsonb NOT NULL,
  registered_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  registered_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_revision_id, container_sha256),
  UNIQUE (id, organization_id),
  UNIQUE (id, plan_revision_id, organization_id),
  CONSTRAINT central_needs_import_batches_revision_org_fk
    FOREIGN KEY (plan_revision_id, organization_id)
    REFERENCES public.central_needs_plan_revisions (id, organization_id)
    ON DELETE RESTRICT
);

CREATE INDEX central_needs_import_batches_revision_idx ON public.central_needs_import_batches(plan_revision_id);
CREATE INDEX central_needs_import_batches_org_idx      ON public.central_needs_import_batches(organization_id);

COMMENT ON TABLE public.central_needs_import_batches IS
  'CN-2B: the trusted manifest of one upload container (a standalone workbook or a ZIP archive) and the complete, ordered set of authoritative import sessions it produced. Registered only by the trusted backend, only after every accepted entry has been finalized. A completed session outside a registered batch cannot make a revision submittable.';

CREATE TABLE public.central_needs_import_batch_entries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           uuid NOT NULL,
  plan_revision_id   uuid NOT NULL,
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  entry_ordinal      integer NOT NULL CHECK (entry_ordinal > 0),
  -- NULL for a standalone upload; the exact, verbatim CN-2A archiveEntryPath
  -- for a ZIP member. Stored as evidence, never used to build a storage key.
  archive_entry_path text CHECK (archive_entry_path IS NULL OR btrim(archive_entry_path) <> ''),
  entry_sha256       text NOT NULL CHECK (entry_sha256 ~ '^[0-9a-f]{64}$'),
  import_session_id  uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, entry_ordinal),
  -- One session belongs to at most ONE batch, globally. This is what makes
  -- "every completed session is in exactly one batch" checkable with an
  -- existence test rather than a count.
  UNIQUE (import_session_id),
  CONSTRAINT central_needs_import_batch_entries_batch_fk
    FOREIGN KEY (batch_id, plan_revision_id, organization_id)
    REFERENCES public.central_needs_import_batches (id, plan_revision_id, organization_id)
    ON DELETE RESTRICT,
  -- Declaratively proves the referenced session is in the SAME revision and
  -- the SAME organization as the batch that claims it.
  CONSTRAINT central_needs_import_batch_entries_session_fk
    FOREIGN KEY (import_session_id, plan_revision_id, organization_id)
    REFERENCES public.central_needs_import_sessions (id, plan_revision_id, organization_id)
    ON DELETE RESTRICT
);

CREATE INDEX central_needs_import_batch_entries_batch_idx   ON public.central_needs_import_batch_entries(batch_id);
CREATE INDEX central_needs_import_batch_entries_session_idx ON public.central_needs_import_batch_entries(import_session_id);
CREATE INDEX central_needs_import_batch_entries_org_idx     ON public.central_needs_import_batch_entries(organization_id);

COMMENT ON TABLE public.central_needs_import_batch_entries IS
  'CN-2B: one accepted workbook inside a registered import batch, preserving its ordinal, its exact archiveEntryPath (ZIP only), its own entry SHA-256 — which is NOT the container SHA-256 — and the exact authoritative import session it produced.';

-- RLS: read-only for authorized clients, exactly as M209/M210 do it. There is
-- no client write policy on either table; registration is trusted-backend only.
ALTER TABLE public.central_needs_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_import_batches FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_import_batches FROM PUBLIC;
REVOKE ALL ON TABLE public.central_needs_import_batches FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.central_needs_import_batches FROM authenticated;
GRANT SELECT ON TABLE public.central_needs_import_batches TO authenticated;
CREATE POLICY central_needs_import_batches_select_authorized
  ON public.central_needs_import_batches FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));

ALTER TABLE public.central_needs_import_batch_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_import_batch_entries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_import_batch_entries FROM PUBLIC;
REVOKE ALL ON TABLE public.central_needs_import_batch_entries FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.central_needs_import_batch_entries FROM authenticated;
GRANT SELECT ON TABLE public.central_needs_import_batch_entries TO authenticated;
CREATE POLICY central_needs_import_batch_entries_select_authorized
  ON public.central_needs_import_batch_entries FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));

-- ----------------------------------------------------------------------------
-- 4. Internal helper — the review-completeness predicate, in one place.
--
--    It is a single function precisely so the submit gate and any diagnostic
--    surface can never drift apart, the same reasoning M210 applied to its
--    shared payload-validation gate.
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
   );
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid) IS
  'CN-2B internal: the single definition of review completeness. Returns one row per unmet submission precondition, empty when the revision is ready. Shared by the submit gate so UI and server can never disagree about what "complete" means.';

-- ----------------------------------------------------------------------------
-- 5. RPC — explicit disposition write (the general case).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_set_record_disposition(
  p_import_session_id uuid,
  p_target_entity     text,
  p_decision          text,
  p_central_item_id   uuid   DEFAULT NULL,
  p_decision_reason   text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_session    public.central_needs_import_sessions%ROWTYPE;
  v_revision   public.central_needs_plan_revisions%ROWTYPE;
  v_entity     text := NULLIF(btrim(p_target_entity), '');
  v_decision   text := NULLIF(btrim(p_decision), '');
  v_reason     text := NULLIF(btrim(p_decision_reason), '');
  v_item       uuid;
  v_item_label text;
  v_existing   public.central_needs_record_mappings%ROWTYPE;
  v_row        public.central_needs_record_mappings%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_import_session_id IS NULL THEN
    RAISE EXCEPTION 'import_session_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_entity IS NULL THEN
    RAISE EXCEPTION 'target_entity_required' USING ERRCODE = '23514';
  END IF;
  IF v_decision IS NULL OR v_decision NOT IN ('mapped', 'not_applicable') THEN
    RAISE EXCEPTION 'decision_must_be_mapped_or_not_applicable' USING ERRCODE = '23514',
      DETAIL = format('decision=%s', COALESCE(v_decision, '<null>'));
  END IF;

  -- Shape the two cases before any write so the table CHECK is a backstop,
  -- never the primary error surface.
  IF v_decision = 'mapped' THEN
    IF p_central_item_id IS NULL THEN
      RAISE EXCEPTION 'mapped_decision_requires_central_item_id' USING ERRCODE = '23514';
    END IF;
    v_item := p_central_item_id;
  ELSE
    IF p_central_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'not_applicable_decision_must_not_carry_central_item_id' USING ERRCODE = '23514';
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'not_applicable_decision_requires_reason' USING ERRCODE = '23514',
        HINT = 'Record why this row carries no central item — a subtotal, a note, a header remnant or a continuation of the row above.';
    END IF;
    v_item := NULL;
  END IF;

  SELECT * INTO v_session
    FROM public.central_needs_import_sessions
   WHERE id = p_import_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'import_session_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- load -> authorize -> assert-editable, so an unauthorized caller never
  -- learns the workflow state of a revision they may not see.
  v_actor_role := public._phoenix_central_needs_guard_v1(v_session.organization_id, 'central_needs.edit');
  v_revision   := public._phoenix_central_needs_load_revision_v1(v_session.plan_revision_id);
  PERFORM public._phoenix_central_needs_assert_draft_v1(v_session.plan_revision_id, v_revision.status);

  IF NOT EXISTS (
    SELECT 1 FROM public.central_needs_source_records
     WHERE import_session_id = p_import_session_id AND target_entity = v_entity
  ) THEN
    RAISE EXCEPTION 'target_entity_not_in_import_session' USING ERRCODE = 'P0002',
      DETAIL = format('session=%s target_entity=%s', p_import_session_id, v_entity),
      HINT = 'Only an entity present in this session''s authoritative source evidence can carry a disposition.';
  END IF;

  IF v_item IS NOT NULL THEN
    SELECT name INTO v_item_label FROM public.central_items WHERE id = v_item;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'central_item_not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  SELECT * INTO v_existing
    FROM public.central_needs_record_mappings
   WHERE import_session_id = p_import_session_id AND target_entity = v_entity
   FOR UPDATE;

  IF FOUND
     AND v_existing.decision = v_decision
     AND v_existing.central_item_id IS NOT DISTINCT FROM v_item
     AND v_existing.decision_reason IS NOT DISTINCT FROM v_reason THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'mapping_id', v_existing.id, 'import_session_id', p_import_session_id,
      'target_entity', v_entity, 'decision', v_decision,
      'central_item_id', v_item
    );
  END IF;

  INSERT INTO public.central_needs_record_mappings (
    import_session_id, organization_id, target_entity, central_item_id,
    decision, decision_reason, mapped_by, decided_by, decided_at
  ) VALUES (
    p_import_session_id, v_session.organization_id, v_entity, v_item,
    v_decision, v_reason, v_actor, v_actor, now()
  )
  ON CONFLICT (import_session_id, target_entity) DO UPDATE
    SET central_item_id  = EXCLUDED.central_item_id,
        decision         = EXCLUDED.decision,
        decision_reason  = EXCLUDED.decision_reason,
        mapped_by        = EXCLUDED.mapped_by,
        decided_by       = EXCLUDED.decided_by,
        decided_at       = EXCLUDED.decided_at
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_session.organization_id, v_actor, v_actor_role,
    'central_needs.record_disposition.set', 'central_needs_record_mapping', v_row.id,
    COALESCE(v_item_label, v_entity),
    jsonb_build_object(
      'import_session_id', p_import_session_id,
      'plan_revision_id', v_session.plan_revision_id,
      'source_file_id', v_session.source_file_id,
      'target_entity', v_entity,
      'decision', v_decision,
      'decision_reason', v_reason,
      'central_item_id', v_item,
      'previous_decision', v_existing.decision,
      'previous_central_item_id', v_existing.central_item_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'mapping_id', v_row.id, 'import_session_id', p_import_session_id,
    'target_entity', v_entity, 'decision', v_decision,
    'central_item_id', v_item,
    'previous_decision', v_existing.decision,
    'previous_central_item_id', v_existing.central_item_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_set_record_disposition(uuid, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_set_record_disposition(uuid, text, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_set_record_disposition(uuid, text, text, uuid, text) IS
  'CN-2B: records the explicit human disposition of one imported target_entity — ''mapped'' with a central item, or ''not_applicable'' with a mandatory reason. Draft revisions only, central_needs.edit, exact organization boundary, archived organizations refused, fully audited. Never infers a decision.';

-- ----------------------------------------------------------------------------
-- 6. RPC — M210's mapping call, preserved verbatim in signature and behaviour,
--    now expressed as the 'mapped' case of the disposition model.
--
--    Kept so existing callers and M210's own contract tests keep working; it
--    is a thin, explicit specialization, not a second ledger.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_set_record_mapping(
  p_import_session_id uuid,
  p_target_entity     text,
  p_central_item_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_central_item_id IS NULL THEN
    RAISE EXCEPTION 'central_item_id_required' USING ERRCODE = '23514';
  END IF;

  v_result := public.phoenix_central_needs_set_record_disposition(
    p_import_session_id, p_target_entity, 'mapped', p_central_item_id, NULL
  );

  -- M210's response shape, preserved exactly for compatibility.
  RETURN jsonb_build_object(
    'ok', v_result->'ok',
    'idempotent_replay', v_result->'idempotent_replay',
    'mapping_id', v_result->'mapping_id',
    'import_session_id', v_result->'import_session_id',
    'target_entity', v_result->'target_entity',
    'central_item_id', v_result->'central_item_id',
    'previous_central_item_id', v_result->'previous_central_item_id'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_set_record_mapping(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_set_record_mapping(uuid, text, uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 7. RPC — reasoned abandonment of an open attempt.
--
--    Deliberately NOT a timeout. Nothing here expires a session on a clock;
--    an authorized human states a reason and the transition is audited.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_abandon_import_session(
  p_import_session_id uuid,
  p_reason            text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_session    public.central_needs_import_sessions%ROWTYPE;
  v_revision   public.central_needs_plan_revisions%ROWTYPE;
  v_reason     text := NULLIF(btrim(p_reason), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_import_session_id IS NULL THEN
    RAISE EXCEPTION 'import_session_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'abandon_reason_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_session
    FROM public.central_needs_import_sessions
   WHERE id = p_import_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'import_session_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_actor_role := public._phoenix_central_needs_guard_v1(v_session.organization_id, 'central_needs.import');
  v_revision   := public._phoenix_central_needs_load_revision_v1(v_session.plan_revision_id);
  PERFORM public._phoenix_central_needs_assert_draft_v1(v_session.plan_revision_id, v_revision.status);

  IF v_session.status = 'failed' THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'import_session_id', p_import_session_id, 'status', 'failed'
    );
  END IF;

  IF v_session.status NOT IN ('pending', 'processing') THEN
    RAISE EXCEPTION 'import_session_not_abandonable' USING ERRCODE = '23514',
      DETAIL = format('session=%s status=%s', p_import_session_id, v_session.status),
      HINT = 'Only a pending or processing attempt can be abandoned. A completed import is immutable evidence.';
  END IF;

  -- Source evidence is never touched: a session can only carry source records
  -- once it has completed, and a completed session is refused above.
  UPDATE public.central_needs_import_sessions
     SET status = 'failed',
         notes  = v_reason
   WHERE id = p_import_session_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_session.organization_id, v_actor, v_actor_role,
    'central_needs.import_session.abandon', 'central_needs_import_session', p_import_session_id,
    NULL,
    jsonb_build_object(
      'plan_revision_id', v_session.plan_revision_id,
      'source_file_id', v_session.source_file_id,
      'from_status', v_session.status,
      'to_status', 'failed',
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'import_session_id', p_import_session_id, 'status', 'failed',
    'from_status', v_session.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_abandon_import_session(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_abandon_import_session(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_abandon_import_session(uuid, text) IS
  'CN-2B: closes an open (pending/processing) import attempt as failed with a mandatory reason. Requires central_needs.import on a draft revision. Never touches source evidence and never expires anything automatically.';

-- ----------------------------------------------------------------------------
-- 8. RPC — start_import_session.
--
--    Superseded within this same migration by section 13. M210 returned the
--    latest session for a (revision, file hash) pair with no state
--    discrimination; the explicit retry semantics that replace it now live in
--    phoenix_central_needs_start_import_entry_session, because the identity
--    itself had to widen to include the archive entry. Defining the 7-argument
--    form here as well would leave dead SQL — the later definition simply wins
--    at apply time — so the single definition sits in section 13 and delegates.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 9. TRUSTED RPC — atomic batch registration.
--
--    THE ONLY WRITER OF THE BATCH MANIFEST, AND NOT CLIENT-CALLABLE.
--    Reachable by service_role alone, via migration 109's default privileges —
--    the same trusted-backend identity M163 and M210 already use.
--
--    It validates the WHOLE manifest before writing any of it, so a partially
--    replayed archive can never be registered: either every accepted entry is
--    present and completed, or nothing is recorded and the revision stays
--    unsubmittable.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_register_import_batch(
  p_plan_revision_id     uuid,
  p_container_kind       text,
  p_container_filename   text,
  p_container_sha256     text,
  p_storage_locator      text,
  p_entries              jsonb,
  p_parser_identity      jsonb,
  p_container_byte_size  bigint  DEFAULT NULL,
  p_excluded_entry_count integer DEFAULT 0,
  p_reconciliation       jsonb   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_revision  public.central_needs_plan_revisions%ROWTYPE;
  v_batch     public.central_needs_import_batches%ROWTYPE;
  v_existing  public.central_needs_import_batches%ROWTYPE;
  v_kind      text := NULLIF(btrim(p_container_kind), '');
  v_filename  text := NULLIF(btrim(p_container_filename), '');
  v_locator   text := NULLIF(btrim(p_storage_locator), '');
  v_count     integer;
  v_inserted  bigint;
  v_manifest  jsonb;
  v_existing_manifest jsonb;
BEGIN
  IF p_plan_revision_id IS NULL THEN
    RAISE EXCEPTION 'plan_revision_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('file', 'zip') THEN
    RAISE EXCEPTION 'container_kind_must_be_file_or_zip' USING ERRCODE = '23514';
  END IF;
  IF v_filename IS NULL THEN
    RAISE EXCEPTION 'container_filename_required' USING ERRCODE = '23514';
  END IF;
  IF p_container_sha256 IS NULL OR p_container_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'container_sha256_must_be_lowercase_sha256_hex' USING ERRCODE = '23514';
  END IF;
  IF v_locator IS NULL THEN
    RAISE EXCEPTION 'storage_locator_required' USING ERRCODE = '23514';
  END IF;
  IF p_parser_identity IS NULL OR jsonb_typeof(p_parser_identity) <> 'object' THEN
    RAISE EXCEPTION 'parser_identity_object_required' USING ERRCODE = '23514';
  END IF;
  IF COALESCE(p_parser_identity->>'runtime', '') <> 'node' THEN
    RAISE EXCEPTION 'batch_registration_must_be_node_runtime' USING ERRCODE = '23514',
      DETAIL = format('runtime=%s', COALESCE(p_parser_identity->>'runtime', '<absent>'));
  END IF;
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'batch_requires_at_least_one_accepted_entry' USING ERRCODE = '23514';
  END IF;
  IF COALESCE(p_excluded_entry_count, 0) < 0 THEN
    RAISE EXCEPTION 'excluded_entry_count_must_not_be_negative' USING ERRCODE = '23514';
  END IF;

  v_count := jsonb_array_length(p_entries);

  -- Structural validation of every entry, before anything is written.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_entries) AS e(r)
    WHERE jsonb_typeof(e.r) <> 'object'
       OR NOT (e.r ? 'entryOrdinal')
       OR jsonb_typeof(e.r->'entryOrdinal') <> 'number'
       OR NOT (e.r ? 'entrySha256')
       OR COALESCE(e.r->>'entrySha256', '') !~ '^[0-9a-f]{64}$'
       OR NOT (e.r ? 'importSessionId')
       OR COALESCE(btrim(e.r->>'importSessionId'), '') = ''
  ) THEN
    RAISE EXCEPTION 'batch_entry_requires_ordinal_sha256_and_session' USING ERRCODE = '23514';
  END IF;

  -- Ordinals must be exactly 1..N, each once. A gap would mean the manifest
  -- itself is incomplete, which is the very condition this table exists to
  -- make impossible.
  IF (
    SELECT count(DISTINCT (e.r->>'entryOrdinal')::int) FROM jsonb_array_elements(p_entries) AS e(r)
  ) <> v_count
  OR (
    SELECT min((e.r->>'entryOrdinal')::int) FROM jsonb_array_elements(p_entries) AS e(r)
  ) <> 1
  OR (
    SELECT max((e.r->>'entryOrdinal')::int) FROM jsonb_array_elements(p_entries) AS e(r)
  ) <> v_count THEN
    RAISE EXCEPTION 'batch_entry_ordinals_must_be_exactly_one_through_n' USING ERRCODE = '23514',
      DETAIL = format('entries=%s', v_count);
  END IF;

  -- Container shape. A standalone upload is one entry with no archive path;
  -- a ZIP names every member exactly.
  IF v_kind = 'file' THEN
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'standalone_batch_must_have_exactly_one_entry' USING ERRCODE = '23514',
        DETAIL = format('entries=%s', v_count);
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_entries) AS e(r)
      WHERE COALESCE(btrim(e.r->>'archiveEntryPath'), '') <> ''
    ) THEN
      RAISE EXCEPTION 'standalone_batch_entry_must_not_carry_archive_entry_path' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_entries) AS e(r)
      WHERE COALESCE(btrim(e.r->>'archiveEntryPath'), '') = ''
    ) THEN
      RAISE EXCEPTION 'zip_batch_entry_requires_archive_entry_path' USING ERRCODE = '23514';
    END IF;
  END IF;

  v_revision := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);

  -- Trusted, but never exempt from the archive rule (M210 section 8 precedent).
  PERFORM public._phoenix_central_needs_assert_org_live_v1(v_revision.organization_id);
  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_revision.status);

  -- The canonical manifest form, used for both the idempotency comparison and
  -- the audit payload. Ordered by ordinal so two registrations of the same
  -- archive compare equal regardless of array order.
  SELECT jsonb_agg(
           jsonb_build_object(
             'entryOrdinal', (e.r->>'entryOrdinal')::int,
             'archiveEntryPath', NULLIF(btrim(COALESCE(e.r->>'archiveEntryPath', '')), ''),
             'entrySha256', e.r->>'entrySha256',
             'importSessionId', e.r->>'importSessionId'
           )
           ORDER BY (e.r->>'entryOrdinal')::int
         )
    INTO v_manifest
    FROM jsonb_array_elements(p_entries) AS e(r);

  PERFORM pg_advisory_xact_lock(hashtextextended(p_plan_revision_id::text || ':' || p_container_sha256, 211001));

  -- Lost-response retry. "Exact" means EXACT: the container identity
  -- (revision + sha256) selects the row, and then EVERY persisted semantic must
  -- match as well — kind, filename, byte size, storage locator, excluded count,
  -- reconciliation, parser identity, accepted count and the complete ordered
  -- entry manifest. Comparing the manifest alone would let a retry silently
  -- rewrite the container's recorded metadata while looking idempotent, so any
  -- divergence under an already-registered container identity fails closed.
  SELECT * INTO v_existing
    FROM public.central_needs_import_batches
   WHERE plan_revision_id = p_plan_revision_id AND container_sha256 = p_container_sha256
   FOR UPDATE;
  IF FOUND THEN
    SELECT COALESCE(jsonb_agg(
             jsonb_build_object(
               'entryOrdinal', e.entry_ordinal,
               'archiveEntryPath', e.archive_entry_path,
               'entrySha256', e.entry_sha256,
               'importSessionId', e.import_session_id::text
             ) ORDER BY e.entry_ordinal
           ), '[]'::jsonb)
      INTO v_existing_manifest
      FROM public.central_needs_import_batch_entries e
     WHERE e.batch_id = v_existing.id;

    IF v_existing_manifest    IS NOT DISTINCT FROM v_manifest
   AND v_existing.container_kind       IS NOT DISTINCT FROM v_kind
   AND v_existing.container_filename   IS NOT DISTINCT FROM v_filename
   AND v_existing.container_byte_size  IS NOT DISTINCT FROM p_container_byte_size
   AND v_existing.storage_locator      IS NOT DISTINCT FROM v_locator
   AND v_existing.excluded_entry_count IS NOT DISTINCT FROM COALESCE(p_excluded_entry_count, 0)
   AND v_existing.reconciliation       IS NOT DISTINCT FROM p_reconciliation
   AND v_existing.parser_identity      IS NOT DISTINCT FROM p_parser_identity
   AND v_existing.accepted_entry_count IS NOT DISTINCT FROM v_count THEN
      RETURN jsonb_build_object(
        'ok', true, 'idempotent_replay', true,
        'batch_id', v_existing.id, 'plan_revision_id', p_plan_revision_id,
        'accepted_entry_count', v_existing.accepted_entry_count
      );
    END IF;

    RAISE EXCEPTION 'import_batch_already_registered_with_different_evidence' USING ERRCODE = '23514',
      DETAIL = format('batch=%s container_sha256=%s', v_existing.id, p_container_sha256),
      HINT = 'A container identity may be registered once. Every recorded semantic must match exactly for a retry to be treated as idempotent.';
  END IF;

  -- Every referenced session must exist, be completed, and belong to exactly
  -- this revision and organization. The composite FK proves revision/org
  -- again declaratively at INSERT time; this check produces the honest error.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_entries) AS e(r)
      LEFT JOIN public.central_needs_import_sessions s
        ON s.id = (e.r->>'importSessionId')::uuid
     WHERE s.id IS NULL
        OR s.plan_revision_id <> p_plan_revision_id
        OR s.organization_id  <> v_revision.organization_id
        OR s.status <> 'completed'
  ) THEN
    RAISE EXCEPTION 'batch_entry_session_must_be_completed_in_this_revision' USING ERRCODE = '23514',
      HINT = 'Register a batch only after every accepted entry has been finalized by the trusted authoritative replay.';
  END IF;

  -- The entry hash must be the hash of the source file that session imported.
  -- This is what stops an outer container hash, or another entry''s hash, from
  -- being recorded against the wrong session.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_entries) AS e(r)
      JOIN public.central_needs_import_sessions s ON s.id = (e.r->>'importSessionId')::uuid
      JOIN public.central_needs_source_files f    ON f.id = s.source_file_id
     WHERE f.file_hash <> (e.r->>'entrySha256')
  ) THEN
    RAISE EXCEPTION 'batch_entry_sha256_does_not_match_session_source_file' USING ERRCODE = '23514',
      HINT = 'Each entry records its OWN workbook fingerprint; the container archive has its own separate hash.';
  END IF;

  -- The session must be the one that imported THIS entry, not merely a session
  -- over the same bytes. Without this, two byte-identical members of one ZIP
  -- could each name the other's session and the manifest would still look
  -- well-formed. The session's own recorded entry_path is the proof.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_entries) AS e(r)
      JOIN public.central_needs_import_sessions s ON s.id = (e.r->>'importSessionId')::uuid
     WHERE COALESCE(s.entry_path, '') IS DISTINCT FROM
           COALESCE(NULLIF(btrim(COALESCE(e.r->>'archiveEntryPath', '')), ''), '')
  ) THEN
    RAISE EXCEPTION 'batch_entry_path_does_not_match_session_entry_path' USING ERRCODE = '23514',
      HINT = 'One accepted archive entry, one import session: the session must record the same archiveEntryPath the manifest claims for it.';
  END IF;

  INSERT INTO public.central_needs_import_batches (
    plan_revision_id, organization_id, container_kind, container_filename,
    container_sha256, container_byte_size, storage_locator,
    accepted_entry_count, excluded_entry_count, reconciliation, parser_identity, registered_by
  ) VALUES (
    p_plan_revision_id, v_revision.organization_id, v_kind, v_filename,
    p_container_sha256, p_container_byte_size, v_locator,
    v_count, COALESCE(p_excluded_entry_count, 0), p_reconciliation, p_parser_identity, NULL
  )
  RETURNING * INTO v_batch;

  WITH ins AS (
    INSERT INTO public.central_needs_import_batch_entries (
      batch_id, plan_revision_id, organization_id, entry_ordinal,
      archive_entry_path, entry_sha256, import_session_id
    )
    SELECT
      v_batch.id, p_plan_revision_id, v_revision.organization_id,
      (e.r->>'entryOrdinal')::int,
      NULLIF(btrim(COALESCE(e.r->>'archiveEntryPath', '')), ''),
      e.r->>'entrySha256',
      (e.r->>'importSessionId')::uuid
    FROM jsonb_array_elements(p_entries) AS e(r)
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  IF v_inserted <> v_count THEN
    RAISE EXCEPTION 'batch_entry_insert_count_mismatch' USING ERRCODE = '23514',
      DETAIL = format('expected=%s inserted=%s', v_count, v_inserted);
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, NULL, 'service_role',
    'central_needs.import_batch.register', 'central_needs_import_batch', v_batch.id,
    v_filename,
    jsonb_build_object(
      'plan_revision_id', p_plan_revision_id,
      'container_kind', v_kind,
      'container_sha256', p_container_sha256,
      'container_byte_size', p_container_byte_size,
      'storage_locator', v_locator,
      'accepted_entry_count', v_count,
      'excluded_entry_count', COALESCE(p_excluded_entry_count, 0),
      'reconciliation', p_reconciliation,
      'parser_identity', p_parser_identity,
      'entries', v_manifest
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'batch_id', v_batch.id, 'plan_revision_id', p_plan_revision_id,
    'accepted_entry_count', v_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_register_import_batch(uuid, text, text, text, text, jsonb, jsonb, bigint, integer, jsonb)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_register_import_batch(uuid, text, text, text, text, jsonb, jsonb, bigint, integer, jsonb) IS
  'CN-2B trusted backend RPC (service_role only): atomically registers one upload container and the complete ordered set of authoritative import sessions it produced. Validates the entire manifest before writing any of it, so a partially replayed archive is never registered. Refuses archived organizations and non-draft revisions. Idempotent on exact retry. Not executable by anon or authenticated.';

-- ----------------------------------------------------------------------------
-- 10. RPC — submit, now server-enforcing review completeness.
--
--     Signature, authorization and audit action are M210's; only the gate is
--     stronger. Every blocker comes from the single shared predicate in
--     section 4, so the UI cannot claim "ready" while the server disagrees.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_submit_revision(
  p_plan_revision_id uuid
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
  v_blocker    record;
  v_completed  bigint;
  v_batches    bigint;
BEGIN
  v_revision   := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);
  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.edit');
  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_revision.status);

  SELECT blocker, detail INTO v_blocker
    FROM public._phoenix_central_needs_review_blockers_v1(p_plan_revision_id)
   LIMIT 1;

  IF FOUND THEN
    IF v_blocker.blocker = 'no_finalized_import' THEN
      RAISE EXCEPTION 'plan_revision_has_no_finalized_import' USING ERRCODE = '23514',
        HINT = 'Finalize an import with an authoritative Node replay before submitting the revision for review.';
    ELSIF v_blocker.blocker = 'import_session_still_open' THEN
      RAISE EXCEPTION 'plan_revision_has_open_import_session' USING ERRCODE = '23514',
        DETAIL = v_blocker.detail,
        HINT = 'Finish or abandon every pending/processing import attempt before submitting.';
    ELSIF v_blocker.blocker = 'completed_session_not_in_trusted_batch' THEN
      RAISE EXCEPTION 'plan_revision_has_unbatched_completed_import' USING ERRCODE = '23514',
        DETAIL = v_blocker.detail,
        HINT = 'A finalized import that no trusted batch claims may be a partially replayed archive. It cannot be submitted.';
    ELSIF v_blocker.blocker = 'incomplete_trusted_batch' THEN
      RAISE EXCEPTION 'plan_revision_has_incomplete_import_batch' USING ERRCODE = '23514',
        DETAIL = v_blocker.detail;
    ELSIF v_blocker.blocker = 'target_entity_without_disposition' THEN
      RAISE EXCEPTION 'plan_revision_has_undecided_target_entity' USING ERRCODE = '23514',
        DETAIL = v_blocker.detail,
        HINT = 'Every imported row needs an explicit decision: map it to a central item, or mark it not applicable with a reason.';
    ELSE
      RAISE EXCEPTION 'plan_revision_not_ready_for_review' USING ERRCODE = '23514',
        DETAIL = format('blocker=%s %s', v_blocker.blocker, COALESCE(v_blocker.detail, ''));
    END IF;
  END IF;

  SELECT count(*) INTO v_completed
    FROM public.central_needs_import_sessions
   WHERE plan_revision_id = p_plan_revision_id AND status = 'completed';
  SELECT count(*) INTO v_batches
    FROM public.central_needs_import_batches
   WHERE plan_revision_id = p_plan_revision_id;

  UPDATE public.central_needs_plan_revisions
     SET status = 'submitted'
   WHERE id = p_plan_revision_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.submit', 'central_needs_plan_revision', p_plan_revision_id,
    format('revision %s', v_revision.revision_number),
    jsonb_build_object(
      'plan_id', v_revision.plan_id,
      'revision_number', v_revision.revision_number,
      'from_status', 'draft', 'to_status', 'submitted',
      'finalized_import_count', v_completed,
      'registered_batch_count', v_batches
    )
  );

  RETURN jsonb_build_object('ok', true, 'plan_revision_id', p_plan_revision_id, 'status', 'submitted');
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_submit_revision(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_submit_revision(uuid) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_submit_revision(uuid) IS
  'CN-2B: submits a draft revision for review, refusing unless every completeness precondition holds — at least one authoritative import, no open attempt, every completed session inside a complete trusted batch, and an explicit human disposition for every imported target entity.';

-- ----------------------------------------------------------------------------
-- 11. RPC — read-only review readiness, for the UI.
--
--     Exposes the SAME predicate the submit gate uses, so "ready for review"
--     in the interface is never an independent client-side opinion.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_review_readiness(
  p_plan_revision_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_revision public.central_needs_plan_revisions%ROWTYPE;
  v_blockers jsonb;
BEGIN
  IF p_plan_revision_id IS NULL THEN
    RAISE EXCEPTION 'plan_revision_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_revision
    FROM public.central_needs_plan_revisions
   WHERE id = p_plan_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.view');

  SELECT COALESCE(jsonb_agg(jsonb_build_object('blocker', b.blocker, 'detail', b.detail)), '[]'::jsonb)
    INTO v_blockers
    FROM public._phoenix_central_needs_review_blockers_v1(p_plan_revision_id) b;

  RETURN jsonb_build_object(
    'ok', true,
    'plan_revision_id', p_plan_revision_id,
    'status', v_revision.status,
    'ready', jsonb_array_length(v_blockers) = 0,
    'blockers', v_blockers
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_review_readiness(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_review_readiness(uuid) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_review_readiness(uuid) IS
  'CN-2B: read-only projection of the exact submit-gate predicate, so the review UI reports completeness from the server rather than from a client-side opinion. Requires central_needs.view.';

-- ----------------------------------------------------------------------------
-- 12. ROLE ELIGIBILITY — the Central Needs product boundary, server-enforced.
--
--     ZERO ROLE DEFAULTS IS NOT A BOUNDARY. Migration 209 ships the four
--     central_needs keys with no default grant, which means no role holds one
--     TODAY — it does not mean no role ever can. A single accidental row in
--     profile_permission_overrides would otherwise expose source workbooks,
--     annual quantities, mappings, override reasons and internal review
--     evidence to an institution or outlet actor.
--
--     The adopted product boundary is a ROLE CLASS restriction that stands
--     BESIDE the capability check, never instead of it:
--
--         ELIGIBLE  : super_admin, central_warehouse_manager
--         INELIGIBLE: institution_admin, warehouse_officer, outlet_officer,
--                     health_center_manager, and every legacy operational role
--
--     `phoenix_my_role() IN ('super_admin','central_warehouse_manager')` is
--     this repository's existing expression of exactly that class — migration
--     092 uses it verbatim for the monthly-status authority — so this is the
--     canonical rule restated for Central Needs, not a new role policy.
--
--     ACCESS NOW REQUIRES BOTH: role eligible AND capability authorized.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_role_eligible_v1()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- COALESCE, not a bare IN: phoenix_my_role() is NULL when there is no JWT
  -- (and for a profile row that has somehow lost its role), and `NULL IN (...)`
  -- is NULL, not false. A NULL would be filtered-as-false by an RLS USING
  -- clause but would make `IF NOT eligible THEN RAISE` skip its own RAISE —
  -- fail-OPEN in the write guard. This predicate is therefore strictly boolean.
  SELECT COALESCE(public.phoenix_my_role(), '') IN ('super_admin', 'central_warehouse_manager');
$$;

-- Granted to authenticated because RLS policy expressions are evaluated as the
-- invoking role. It discloses nothing: it answers only "is the CALLER's own
-- role eligible", takes no argument, and reads no other profile.
REVOKE ALL ON FUNCTION public._phoenix_central_needs_role_eligible_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._phoenix_central_needs_role_eligible_v1() TO authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_role_eligible_v1() IS
  'CN-2B: true when the caller''s own role is in the Central Needs eligible class (super_admin, central_warehouse_manager). Applied as a RESTRICTIVE RLS policy on every Central Needs relation and inside the client write guard, so role eligibility and capability authorization are both required.';

-- RESTRICTIVE policies AND with the permissive ones migration 209 installed,
-- so this NARROWS the existing surface without editing M209. An ineligible
-- role now reads zero rows from every Central Needs relation, whatever
-- permission it may have been granted by accident.
DO $restrict$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files',
    'central_needs_import_sessions', 'central_needs_source_records',
    'central_needs_field_overrides', 'central_needs_record_mappings',
    'central_needs_import_batches', 'central_needs_import_batch_entries'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      || 'USING (public._phoenix_central_needs_role_eligible_v1()) '
      || 'WITH CHECK (public._phoenix_central_needs_role_eligible_v1())',
      t || '_role_eligible_restrictive', t);
  END LOOP;
END;
$restrict$;

-- The client write guard gains the same rule. Forward-only replacement of the
-- M210 body; M210's own file is untouched. The raised identifier deliberately
-- still CONTAINS `forbidden_central_needs`, so every existing M210 assertion
-- about a refused caller keeps its exact meaning while the reason becomes
-- distinguishable.
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_guard_v1(
  p_organization_id uuid,
  p_permission_key  text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.organizations WHERE id = p_organization_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- CN-2B: role class first, capability second. Both are required.
  IF NOT public._phoenix_central_needs_role_eligible_v1() THEN
    RAISE EXCEPTION 'forbidden_central_needs_role' USING ERRCODE = '42501',
      DETAIL = format('role=%s is outside the Central Needs eligible class', public.phoenix_my_role()),
      HINT = 'Central Needs is restricted to super_admin and central_warehouse_manager.';
  END IF;

  IF NOT public.phoenix_status_center_authorized(p_organization_id, p_permission_key) THEN
    RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE = '42501',
      DETAIL = format('permission=%s organization=%s', p_permission_key, p_organization_id);
  END IF;

  PERFORM public._phoenix_central_needs_assert_org_live_v1(p_organization_id);

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor;
  RETURN v_actor_role;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_guard_v1(uuid, text) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 13. ENTRY IDENTITY — one accepted archive entry, one import session.
--
--     THE DEFECT THIS CLOSES. M210 identifies a session by
--     (plan_revision_id, source_file_id), and a source file by its content
--     hash. A ZIP may legitimately carry the SAME bytes at TWO paths
--     (`north/needs.xls` and `south/needs.xls` can be byte-identical). Under
--     M210's identity both entries resolve to one source file and therefore to
--     ONE session — but `central_needs_import_batch_entries` requires one
--     session per accepted entry, so registration either fails or, worse, one
--     session silently stands for two distinct archive members and one entry's
--     provenance disappears.
--
--     THE CORRECTION. Source BYTES stay content-deduplicated in
--     central_needs_source_files — that is correct and is not changed. What
--     must not collapse is ENTRY provenance, so the session gains the entry's
--     own canonical path as part of its identity. A standalone upload carries
--     NULL, exactly as before.
-- ----------------------------------------------------------------------------
ALTER TABLE public.central_needs_import_sessions
  ADD COLUMN entry_path text
    CONSTRAINT central_needs_import_sessions_entry_path_chk
      CHECK (entry_path IS NULL OR btrim(entry_path) <> '');

COMMENT ON COLUMN public.central_needs_import_sessions.entry_path IS
  'CN-2B: the verbatim CN-2A archiveEntryPath this session imported, or NULL for a standalone workbook. Part of the session''s identity so two byte-identical members of one ZIP cannot collapse into a single session. Evidence only — never used to address storage.';

-- At most ONE live (non-failed) session per revision + source file + entry.
-- Declarative, so the invariant does not depend on the RPC getting it right.
-- Failed attempts are terminal history and are deliberately excluded, which is
-- what lets a failed import be retried.
CREATE UNIQUE INDEX central_needs_import_sessions_live_entry_uidx
  ON public.central_needs_import_sessions (plan_revision_id, source_file_id, COALESCE(entry_path, ''))
  WHERE status <> 'failed';

-- The entry-aware entry point. M210's 7-argument signature is preserved below
-- and delegates here with a NULL entry path, so every existing caller and
-- every M210 contract test keeps its exact behaviour.
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_start_import_entry_session(
  p_plan_revision_id  uuid,
  p_original_filename text,
  p_file_hash         text,
  p_preview_digest    text,
  p_parser_identity   jsonb,
  p_byte_size         bigint,
  p_storage_locator   text,
  p_entry_path        text
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
  v_source_file public.central_needs_source_files%ROWTYPE;
  v_session     public.central_needs_import_sessions%ROWTYPE;
  v_filename    text := NULLIF(btrim(p_original_filename), '');
  v_entry       text := NULLIF(btrim(p_entry_path), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF v_filename IS NULL THEN
    RAISE EXCEPTION 'original_filename_required' USING ERRCODE = '23514';
  END IF;
  IF p_file_hash IS NULL OR p_file_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'file_hash_must_be_lowercase_sha256_hex' USING ERRCODE = '23514';
  END IF;
  IF p_preview_digest IS NULL OR p_preview_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'preview_digest_must_be_lowercase_sha256_hex' USING ERRCODE = '23514';
  END IF;
  IF p_parser_identity IS NULL OR jsonb_typeof(p_parser_identity) <> 'object' THEN
    RAISE EXCEPTION 'parser_identity_object_required' USING ERRCODE = '23514';
  END IF;
  IF p_byte_size IS NOT NULL AND p_byte_size < 0 THEN
    RAISE EXCEPTION 'byte_size_must_not_be_negative' USING ERRCODE = '23514';
  END IF;

  v_revision   := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);
  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.import');
  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_revision.status);

  -- The lock now covers the ENTRY, not just the file, so two members of one
  -- archive with identical bytes serialize independently.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_plan_revision_id::text || ':' || p_file_hash || ':' || COALESCE(v_entry, ''), 210002));

  SELECT * INTO v_source_file
    FROM public.central_needs_source_files
   WHERE plan_revision_id = p_plan_revision_id AND file_hash = p_file_hash;

  IF FOUND THEN
    -- Scoped to THIS entry. Two byte-identical members share a source file but
    -- never a session.
    SELECT * INTO v_session
      FROM public.central_needs_import_sessions
     WHERE plan_revision_id = p_plan_revision_id
       AND source_file_id = v_source_file.id
       AND COALESCE(entry_path, '') = COALESCE(v_entry, '')
     ORDER BY started_at DESC
     LIMIT 1;

    IF FOUND THEN
      IF v_session.status = 'completed' THEN
        RETURN jsonb_build_object(
          'ok', true, 'idempotent_replay', true,
          'import_session_id', v_session.id, 'source_file_id', v_source_file.id,
          'status', v_session.status, 'entry_path', v_session.entry_path
        );
      ELSIF v_session.status IN ('pending', 'processing') THEN
        RETURN jsonb_build_object(
          'ok', true, 'idempotent_replay', true,
          'import_session_id', v_session.id, 'source_file_id', v_source_file.id,
          'status', v_session.status, 'entry_path', v_session.entry_path
        );
      ELSIF v_session.status = 'failed' THEN
        NULL;  -- terminal history; a new attempt for this entry is permitted
      ELSE
        RAISE EXCEPTION 'import_session_unexpected_state' USING ERRCODE = '23514',
          DETAIL = format('session=%s status=%s', v_session.id, v_session.status),
          HINT = 'Refusing to reuse or replace an import session in an unrecognised state.';
      END IF;
    END IF;
  ELSE
    INSERT INTO public.central_needs_source_files (
      plan_revision_id, organization_id, original_filename, file_hash, byte_size, storage_locator, uploaded_by
    ) VALUES (
      p_plan_revision_id, v_revision.organization_id, v_filename, p_file_hash,
      p_byte_size, NULLIF(btrim(p_storage_locator), ''), v_actor
    )
    RETURNING * INTO v_source_file;
  END IF;

  INSERT INTO public.central_needs_import_sessions (
    plan_revision_id, organization_id, source_file_id, status,
    started_by, preview_digest, parser_identity, entry_path
  ) VALUES (
    p_plan_revision_id, v_revision.organization_id, v_source_file.id, 'processing',
    v_actor, p_preview_digest, p_parser_identity, v_entry
  )
  RETURNING * INTO v_session;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.import_session.start', 'central_needs_import_session', v_session.id,
    v_filename,
    jsonb_build_object(
      'plan_revision_id', p_plan_revision_id,
      'source_file_id', v_source_file.id,
      'file_hash', p_file_hash,
      'byte_size', p_byte_size,
      'preview_digest', p_preview_digest,
      'parser_identity', p_parser_identity,
      'entry_path', v_entry
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'import_session_id', v_session.id, 'source_file_id', v_source_file.id,
    'status', v_session.status, 'entry_path', v_session.entry_path
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_start_import_entry_session(uuid, text, text, text, jsonb, bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_start_import_entry_session(uuid, text, text, text, jsonb, bigint, text, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_start_import_entry_session(uuid, text, text, text, jsonb, bigint, text, text) IS
  'CN-2B: starts or reuses the import session for ONE accepted container entry, identified by revision + source-file hash + the entry''s own archive path. Source bytes stay content-deduplicated; entry provenance never collapses. The M210 7-argument form delegates here with a NULL entry path.';

-- M210's signature, preserved exactly, now a standalone-entry specialization.
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_start_import_session(
  p_plan_revision_id  uuid,
  p_original_filename text,
  p_file_hash         text,
  p_preview_digest    text,
  p_parser_identity   jsonb,
  p_byte_size         bigint DEFAULT NULL,
  p_storage_locator   text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN public.phoenix_central_needs_start_import_entry_session(
    p_plan_revision_id, p_original_filename, p_file_hash, p_preview_digest,
    p_parser_identity, p_byte_size, p_storage_locator, NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_start_import_session(uuid, text, text, text, jsonb, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_start_import_session(uuid, text, text, text, jsonb, bigint, text) TO authenticated;

-- ============================================================================
-- 12. VERIFY — fail the migration if any invariant did not land.
-- ============================================================================
DO $verify$
DECLARE
  f text;
  v_sig text;
BEGIN
  -- New relations exist with RLS enabled AND forced.
  FOREACH f IN ARRAY ARRAY['central_needs_import_batches', 'central_needs_import_batch_entries'] LOOP
    IF to_regclass('public.' || f) IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED (211): table % is missing', f;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class WHERE oid = to_regclass('public.' || f) AND relrowsecurity AND relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'VERIFY FAILED (211): table % does not have RLS enabled and forced', f;
    END IF;
    FOREACH v_sig IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege('authenticated', 'public.' || f, v_sig) THEN
        RAISE EXCEPTION 'VERIFY FAILED (211): authenticated holds % on %', v_sig, f;
      END IF;
      IF has_table_privilege('anon', 'public.' || f, v_sig) THEN
        RAISE EXCEPTION 'VERIFY FAILED (211): anon holds % on %', v_sig, f;
      END IF;
    END LOOP;
  END LOOP;

  -- The batch table must NOT carry an entry-level hash column: conflating the
  -- container fingerprint with a member workbook fingerprint is the exact
  -- error this model exists to prevent.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'central_needs_import_batches'
      AND column_name IN ('entry_sha256', 'file_hash')
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (211): the batch container must not carry an entry-level hash column';
  END IF;

  -- Disposition surface.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'central_needs_record_mappings'
      AND column_name = 'central_item_id' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (211): central_item_id must be nullable to express not_applicable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'central_needs_record_mappings'
      AND column_name = 'decision' AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (211): decision must not keep a DEFAULT — every write states its decision';
  END IF;
  FOREACH f IN ARRAY ARRAY[
    'central_needs_record_mappings_decision_vocab_chk',
    'central_needs_record_mappings_disposition_chk'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = f) THEN
      RAISE EXCEPTION 'VERIFY FAILED (211): constraint % is missing', f;
    END IF;
  END LOOP;

  -- Uniqueness that the completeness predicate depends on.
  FOREACH f IN ARRAY ARRAY[
    'central_needs_import_sessions_id_revision_org_key',
    'central_needs_import_batch_entries_import_session_id_key',
    'central_needs_import_batch_entries_batch_fk',
    'central_needs_import_batch_entries_session_fk',
    'central_needs_import_batches_revision_org_fk'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = f) THEN
      RAISE EXCEPTION 'VERIFY FAILED (211): constraint % is missing', f;
    END IF;
  END LOOP;

  -- CN-2B role boundary: the predicate exists, is client-callable (RLS policy
  -- expressions run as the invoking role), and every Central Needs relation
  -- carries a RESTRICTIVE policy that ANDs it with M209's permissive one.
  IF to_regprocedure('public._phoenix_central_needs_role_eligible_v1()') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (211): the role-eligibility predicate is missing';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public._phoenix_central_needs_role_eligible_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (211): authenticated cannot evaluate the role-eligibility predicate';
  END IF;
  IF has_function_privilege('anon', 'public._phoenix_central_needs_role_eligible_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (211): anon can evaluate the role-eligibility predicate';
  END IF;
  FOREACH f IN ARRAY ARRAY[
    'central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files',
    'central_needs_import_sessions', 'central_needs_source_records',
    'central_needs_field_overrides', 'central_needs_record_mappings',
    'central_needs_import_batches', 'central_needs_import_batch_entries'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = f
         AND policyname = f || '_role_eligible_restrictive'
         AND permissive = 'RESTRICTIVE'
    ) THEN
      RAISE EXCEPTION 'VERIFY FAILED (211): % has no RESTRICTIVE role-eligibility policy', f;
    END IF;
  END LOOP;
  IF public._phoenix_central_needs_role_eligible_v1() IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (211): the role-eligibility predicate must never return NULL';
  END IF;

  -- CN-2B entry identity: the column, its CHECK, and the live-entry uniqueness
  -- that makes "one accepted archive entry, one session" declarative.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'central_needs_import_sessions'
       AND column_name = 'entry_path'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (211): central_needs_import_sessions.entry_path is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'central_needs_import_sessions_live_entry_uidx'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (211): the live-entry uniqueness index is missing';
  END IF;

  -- Client-callable RPCs.
  FOREACH f IN ARRAY ARRAY[
    'public.phoenix_central_needs_start_import_entry_session(uuid, text, text, text, jsonb, bigint, text, text)',
    'public.phoenix_central_needs_set_record_disposition(uuid, text, text, uuid, text)',
    'public.phoenix_central_needs_set_record_mapping(uuid, text, uuid)',
    'public.phoenix_central_needs_abandon_import_session(uuid, text)',
    'public.phoenix_central_needs_start_import_session(uuid, text, text, text, jsonb, bigint, text)',
    'public.phoenix_central_needs_submit_revision(uuid)',
    'public.phoenix_central_needs_review_readiness(uuid)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED (211): client RPC % is missing', f;
    END IF;
    IF NOT has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (211): authenticated cannot execute %', f;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (211): anon can execute %', f;
    END IF;
  END LOOP;

  -- Trusted-only surfaces: never reachable by a browser session.
  FOREACH f IN ARRAY ARRAY[
    'public.phoenix_central_needs_register_import_batch(uuid, text, text, text, text, jsonb, jsonb, bigint, integer, jsonb)',
    'public._phoenix_central_needs_review_blockers_v1(uuid)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED (211): trusted function % is missing', f;
    END IF;
    IF EXISTS (
      SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = to_regprocedure(f)))
      WHERE grantee IN (0, 'anon'::regrole, 'authenticated'::regrole) AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'VERIFY FAILED (211): trusted function % is client-callable', f;
    END IF;
  END LOOP;

  -- Permission surface unchanged. CN-2B creates no permission key and no grant.
  IF (SELECT count(*) FROM public.permission_keys WHERE module = 'central_needs') <> 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED (211): the central_needs permission key count changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.permission_keys WHERE key = 'central_needs.send') THEN
    RAISE EXCEPTION 'VERIFY FAILED (211): central_needs.send must never exist';
  END IF;
  IF EXISTS (SELECT 1 FROM public.role_permission_defaults WHERE permission_key LIKE 'central_needs.%') THEN
    RAISE EXCEPTION 'VERIFY FAILED (211): central_needs.* must keep zero default role grants';
  END IF;

  -- No client write grant leaked onto any Central Needs table.
  FOREACH f IN ARRAY ARRAY[
    'central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files',
    'central_needs_import_sessions', 'central_needs_source_records',
    'central_needs_field_overrides', 'central_needs_record_mappings',
    'central_needs_import_batches', 'central_needs_import_batch_entries'
  ] LOOP
    FOREACH v_sig IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege('authenticated', 'public.' || f, v_sig) THEN
        RAISE EXCEPTION 'VERIFY FAILED (211): authenticated holds % on %', v_sig, f;
      END IF;
      IF has_table_privilege('anon', 'public.' || f, v_sig) THEN
        RAISE EXCEPTION 'VERIFY FAILED (211): anon holds % on %', v_sig, f;
      END IF;
    END LOOP;
  END LOOP;
END;
$verify$;

COMMIT;
