-- ============================================================================
-- CN-1B / M210 — CENTRAL NEEDS IMPORT / REVIEW WORKFLOW RPCs
--
-- M209 (CN-1A) landed the Central Needs registry as schema + RLS + permission
-- keys ONLY, with every client INSERT/UPDATE/DELETE grant revoked and an
-- explicit note that "review/approval/import-finalization RPCs are CN-1B".
-- This migration is that CN-1B server-side workflow layer, and nothing else.
--
-- WHAT THIS MIGRATION ADDS
--   1. Three columns on central_needs_import_sessions carrying the CN-2A
--      dual-pass trust evidence, plus ONE declarative CHECK that makes
--      finalization structurally impossible without authoritative agreement.
--   2. One table, central_needs_record_mappings — the canonical-link surface
--      (imported target_entity -> central_items), which M209 deliberately did
--      not model because no parser output contract existed yet.
--   3. Seven client-facing SECURITY DEFINER workflow RPCs, each enforcing
--      authorization, organization boundary, archived-organization denial,
--      legal state transition and an explicit in-transaction audit_logs write.
--   4. ONE trusted-backend RPC, reachable by service_role only, which is the
--      sole path that may write authoritative import evidence or move a
--      session to 'completed'.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   - No stock mutation, no movement ledger, no transfer request of any kind,
--     no touch of inventory_transfer_suggestions. Central Needs planning and
--     physical sending stay separate systems; physical sending remains
--     governed by warehouse_transfer.send and is not referenced here.
--   - No new permission key. The four M209 keys (central_needs.view/import/
--     edit/approve) are the complete surface. There is deliberately NO
--     central_needs.send.
--   - No new default role grant. central_needs.* keeps zero rows in
--     role_permission_defaults — access stays opt-in per profile via
--     profile_permission_overrides, exactly as M209 established.
--   - No parallel authorization framework. Every guard composes the existing
--     public.phoenix_status_center_authorized (M092), which M209's own header
--     names as mandatory for CN-1B so that "RLS and RPC authorization never
--     fork".
--   - No trigger-based audit framework. Every audit row is an explicit INSERT
--     inside an RPC body, matching every existing audit_logs writer in this
--     codebase.
--   - No change to M201/M202. Central Needs objects are NOT added to the
--     organizations archive reciprocal dependency set (a historical Central
--     Needs plan must not, by itself, block archiving an organization).
--     Instead each mutating RPC below refuses NEW mutable activity under an
--     archived organization, which is the property that actually matters.
--
-- THE CN-2A TRUST BOUNDARY — WHY A CHECK CONSTRAINT AND NOT JUST RPC CODE
--   CN-2A's frozen contract produces a parse result in one of two runtimes:
--   a provisional browser Worker preview, and an authoritative Node 22 replay
--   keyed by the SHA-256 of the exact input bytes. A browser preview is
--   attacker-influenced and must never be sufficient to finalize an import.
--
--   The session therefore carries preview_digest and authoritative_digest —
--   opaque lowercase-hex SHA-256 digests of each pass's semantic output — and
--   parser_identity, CN-2A's ParserIdentity (contract version, SheetJS
--   version, pinned tarball hash, runtime). The CHECK below states the trust
--   rule declaratively:
--
--       status = 'completed'  =>  both digests present, EQUAL, identity
--                                 recorded, and completed_at stamped.
--
--   Expressing it as a constraint rather than only as RPC logic means a
--   finalized-looking session cannot exist even if reached by a service-role
--   connection, a future RPC, or a hand-written UPDATE — the same reasoning
--   M209 used when it chose composite foreign keys over triggers for its
--   cross-organization guarantees.
--
--   THE CONSTRAINT ALONE IS NOT THE TRUST BOUNDARY. Equality of two digests
--   proves nothing if the same principal supplies both. The boundary is
--   enforced by WHO may write these values, and by WHERE the authoritative
--   digest comes from:
--     * preview_digest is a PROVISIONAL client claim, written at session
--       start by a central_needs.import holder. It is never sufficient.
--     * authoritative_digest is never accepted from any caller. It is
--       RECOMPUTED by the database (section 7) over the source records
--       actually persisted, inside the trusted replay transaction.
--     * Only service_role can reach that transaction (section 8), and only
--       that transaction inserts source records or sets status='completed'.
--   An authenticated client — even holding central_needs.import — therefore
--   cannot manufacture authoritative evidence: it cannot insert source
--   records, cannot set authoritative_digest, and cannot finalize.
--
--   The columns stay parser-NEUTRAL: two opaque hex digests and a shape-free
--   jsonb. No sheet/row/column/workbook-family assumption enters the schema,
--   preserving M209's contract. The canonical digest form is defined in
--   section 7 over generic (target_entity, field_name, source_values) triples
--   only — it reads no parser-specific structure.
--
-- IDEMPOTENCY / REPLAY SAFETY
--   Import identity is deterministic and comes from the frozen contract, not
--   from a client-invented key: a source file is identified by its SHA-256
--   within a revision (M209 already declares UNIQUE (plan_revision_id,
--   file_hash)). Re-running an import for the same revision + same file hash
--   returns the existing session instead of creating a second one, so a
--   retried upload after a dropped connection cannot fork the evidence.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Preconditions — fail closed if M209's surface is not exactly as expected.
-- ----------------------------------------------------------------------------
DO $precondition$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files',
    'central_needs_import_sessions', 'central_needs_source_records', 'central_needs_field_overrides'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '210_precondition_failed: M209 table % is absent', t;
    END IF;
  END LOOP;

  IF to_regprocedure('public.phoenix_status_center_authorized(uuid, text)') IS NULL THEN
    RAISE EXCEPTION '210_precondition_failed: the canonical authorization helper is absent';
  END IF;

  IF to_regclass('public.central_items') IS NULL THEN
    RAISE EXCEPTION '210_precondition_failed: public.central_items is absent';
  END IF;

  IF to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION '210_precondition_failed: public.audit_logs is absent';
  END IF;

  -- organizations.archived_at is M202's archive marker; every guard below
  -- reads it. If it is missing the archived-organization contract cannot be
  -- honoured and this migration must not proceed.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'archived_at'
  ) THEN
    RAISE EXCEPTION '210_precondition_failed: organizations.archived_at (M202) is absent';
  END IF;

  IF to_regclass('public.central_needs_record_mappings') IS NOT NULL THEN
    RAISE EXCEPTION '210_precondition_failed: central_needs_record_mappings already exists';
  END IF;

  FOREACH t IN ARRAY ARRAY['preview_digest', 'authoritative_digest', 'parser_identity'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'central_needs_import_sessions' AND column_name = t
    ) THEN
      RAISE EXCEPTION '210_precondition_failed: central_needs_import_sessions.% already exists', t;
    END IF;
  END LOOP;
END;
$precondition$;

-- ----------------------------------------------------------------------------
-- 1. CN-2A dual-pass trust evidence on the import session.
-- ----------------------------------------------------------------------------
ALTER TABLE public.central_needs_import_sessions
  ADD COLUMN preview_digest       text,
  ADD COLUMN authoritative_digest text,
  ADD COLUMN parser_identity      jsonb;

ALTER TABLE public.central_needs_import_sessions
  ADD CONSTRAINT central_needs_import_sessions_preview_digest_chk
    CHECK (preview_digest IS NULL OR preview_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT central_needs_import_sessions_authoritative_digest_chk
    CHECK (authoritative_digest IS NULL OR authoritative_digest ~ '^[0-9a-f]{64}$'),
  -- THE trust gate. See the header: a 'completed' session cannot exist unless
  -- an authoritative Node replay independently produced the same semantic
  -- digest as the provisional browser preview.
  ADD CONSTRAINT central_needs_import_sessions_authoritative_finalization_chk
    CHECK (
      status <> 'completed'
      OR (
        preview_digest IS NOT NULL
        AND authoritative_digest IS NOT NULL
        AND preview_digest = authoritative_digest
        AND parser_identity IS NOT NULL
        AND completed_at IS NOT NULL
      )
    );

COMMENT ON COLUMN public.central_needs_import_sessions.preview_digest IS
  'CN-1B: lowercase-hex SHA-256 of the PROVISIONAL (browser Worker) parse pass''s semantic output. Attacker-influenced on its own — never sufficient to finalize.';
COMMENT ON COLUMN public.central_needs_import_sessions.authoritative_digest IS
  'CN-1B: lowercase-hex SHA-256 of the AUTHORITATIVE Node replay''s semantic output. Must equal preview_digest before the session may reach status=''completed''.';
COMMENT ON COLUMN public.central_needs_import_sessions.parser_identity IS
  'CN-1B: the upstream parser identity record of the authoritative pass (contract version, parser version, pinned artifact hash, runtime). Shape-free jsonb — the database asserts presence and the runtime field, never parser shape.';

-- ----------------------------------------------------------------------------
-- 2. central_needs_record_mappings — the canonical-link surface.
--
--    One row per (plan revision, imported target_entity), naming the
--    central_items row that entity resolves to. Follows M209's structural
--    conventions exactly: organization_id carries its own FK to organizations
--    AND a composite FK proving it agrees with the parent revision, RLS is
--    enabled and forced, and no client write grant exists at all.
--
--    Unlike source evidence this table is deliberately MUTABLE: a mapping is
--    a human correction, not imported evidence, and re-pointing a mis-mapped
--    line is the whole purpose of the review step. Source evidence remains
--    untouched by every mapping write.
-- ----------------------------------------------------------------------------
CREATE TABLE public.central_needs_record_mappings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_revision_id uuid NOT NULL,
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  target_entity    text NOT NULL CHECK (length(target_entity) > 0),
  central_item_id  uuid NOT NULL REFERENCES public.central_items(id) ON DELETE RESTRICT,
  mapped_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_revision_id, target_entity),
  CONSTRAINT central_needs_record_mappings_revision_org_fk
    FOREIGN KEY (plan_revision_id, organization_id)
    REFERENCES public.central_needs_plan_revisions (id, organization_id)
    ON DELETE RESTRICT
);

CREATE INDEX central_needs_record_mappings_revision_idx ON public.central_needs_record_mappings(plan_revision_id);
CREATE INDEX central_needs_record_mappings_org_idx      ON public.central_needs_record_mappings(organization_id);
CREATE INDEX central_needs_record_mappings_item_idx     ON public.central_needs_record_mappings(central_item_id);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.central_needs_record_mappings
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at();

COMMENT ON TABLE public.central_needs_record_mappings IS
  'CN-1B: canonical link from an imported Central Needs target_entity to a central_items row, per plan revision. Mutable by design (a mapping is a correction, not source evidence). No client write path; mutated only by phoenix_central_needs_set_record_mapping.';

ALTER TABLE public.central_needs_record_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_record_mappings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_record_mappings FROM PUBLIC;
REVOKE ALL ON TABLE public.central_needs_record_mappings FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.central_needs_record_mappings FROM authenticated;
GRANT SELECT ON TABLE public.central_needs_record_mappings TO authenticated;
CREATE POLICY central_needs_record_mappings_select_authorized
  ON public.central_needs_record_mappings FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));

-- ----------------------------------------------------------------------------
-- 3. Shared internal guard.
--
--    This is a COMPOSITION of the existing canonical helper, not a second
--    authorization system: it calls public.phoenix_status_center_authorized
--    (which already enforces authenticated + active profile + organization
--    match + permission key, and grants super_admin org-wide access) and adds
--    only the two checks that helper cannot know about — that the target
--    organization exists, and that it is not archived.
--
--    Returning the actor's role keeps every audit row's actor_role consistent
--    with the rest of the codebase without each RPC repeating the lookup.
-- ----------------------------------------------------------------------------
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
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_archived_at timestamptz;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;

  -- Organization must exist. FOR KEY SHARE is the same concurrency fence
  -- M202's reciprocal guard uses: it conflicts with the FOR UPDATE an archive
  -- takes, so an archive cannot commit underneath an in-flight mutation.
  SELECT archived_at INTO v_archived_at
    FROM public.organizations
   WHERE id = p_organization_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Authorization: the canonical helper, never a reimplementation of it.
  IF NOT public.phoenix_status_center_authorized(p_organization_id, p_permission_key) THEN
    RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE = '42501',
      DETAIL = format('permission=%s organization=%s', p_permission_key, p_organization_id);
  END IF;

  -- Archived organizations accept no NEW mutable Central Needs activity.
  -- Historical rows stay readable and stay put; only mutation is refused.
  IF v_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'central_needs_write_blocked_by_archived_organization'
      USING ERRCODE = '23514',
      DETAIL = format('organization=%s archived_at=%s', p_organization_id, v_archived_at),
      HINT = 'Restore the organization before creating or changing Central Needs data under it.';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor;
  RETURN v_actor_role;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_guard_v1(uuid, text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_guard_v1(uuid, text) IS
  'CN-1B internal: composes public.phoenix_status_center_authorized with organization existence and archived-organization denial. Not a parallel authorization system and not client-callable.';

-- ----------------------------------------------------------------------------
-- 4. Internal: resolve a revision, and (separately) assert it is editable.
--
--    These are deliberately TWO steps, not one. Every RPC below runs them in
--    the order load -> authorize -> assert-editable, so an unauthorized
--    caller is refused on authorization grounds BEFORE the workflow state of
--    a revision they may not see is disclosed to them. Collapsing them into a
--    single "fetch an editable revision" helper would leak state to a caller
--    who has no right to it.
--
--    'draft' is the only state in which imported content, mappings and
--    overrides may change. 'submitted' is under review, and 'approved' /
--    'superseded' / 'rejected' are historical. Every state name here is one
--    M209 already defined — CN-1B invents none.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_load_revision_v1(
  p_plan_revision_id uuid
)
RETURNS public.central_needs_plan_revisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_revision public.central_needs_plan_revisions%ROWTYPE;
BEGIN
  IF p_plan_revision_id IS NULL THEN
    RAISE EXCEPTION 'plan_revision_id_required' USING ERRCODE = '23514';
  END IF;

  -- FOR UPDATE serializes concurrent workflow writes against the same
  -- revision, so a state transition and a content mutation cannot interleave
  -- and leave content attached to an already-approved revision.
  SELECT * INTO v_revision
    FROM public.central_needs_plan_revisions
   WHERE id = p_plan_revision_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_revision;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_load_revision_v1(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._phoenix_central_needs_assert_draft_v1(
  p_plan_revision_id uuid,
  p_status           text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_status <> 'draft' THEN
    RAISE EXCEPTION 'plan_revision_not_editable' USING ERRCODE = '23514',
      DETAIL = format('revision=%s status=%s', p_plan_revision_id, p_status),
      HINT = 'Only a draft revision accepts imported content, mappings and overrides. Create a new revision to change approved history.';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_draft_v1(uuid, text) FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 5. RPC — open a plan revision (revision workflow).
--
--    Creates the annual plan on first use and opens revision 1, or opens the
--    next revision when the caller explicitly supersedes the current approved
--    one. An approved revision is never mutated in place: it transitions to
--    'superseded' and KEEPS its approved_by/approved_at record, which M209's
--    approval-pair CHECK explicitly permits, so approved history stays
--    traceable.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_open_plan_revision(
  p_organization_id uuid,
  p_plan_year       integer,
  p_supersede       boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_plan       public.central_needs_plans%ROWTYPE;
  v_current    public.central_needs_plan_revisions%ROWTYPE;
  v_new        public.central_needs_plan_revisions%ROWTYPE;
BEGIN
  v_actor_role := public._phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.edit');

  IF p_plan_year IS NULL THEN
    RAISE EXCEPTION 'plan_year_required' USING ERRCODE = '23514';
  END IF;

  -- Serialize concurrent openers of the same (organization, year).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_plan_year::text, 210001));

  SELECT * INTO v_plan
    FROM public.central_needs_plans
   WHERE organization_id = p_organization_id AND plan_year = p_plan_year
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.central_needs_plans (organization_id, plan_year, created_by)
    VALUES (p_organization_id, p_plan_year, v_actor)
    RETURNING * INTO v_plan;
  END IF;

  SELECT * INTO v_current
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id
   ORDER BY revision_number DESC
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    -- An existing draft is the revision to work in — opening is idempotent.
    IF v_current.status = 'draft' THEN
      RETURN jsonb_build_object(
        'ok', true, 'idempotent_replay', true,
        'plan_id', v_plan.id, 'plan_revision_id', v_current.id,
        'revision_number', v_current.revision_number, 'status', v_current.status
      );
    END IF;

    IF NOT p_supersede THEN
      RAISE EXCEPTION 'plan_revision_already_closed' USING ERRCODE = '23514',
        DETAIL = format('revision=%s status=%s', v_current.id, v_current.status),
        HINT = 'Pass p_supersede => true to open a new revision superseding the current one.';
    END IF;

    IF v_current.status <> 'approved' THEN
      RAISE EXCEPTION 'only_an_approved_revision_may_be_superseded' USING ERRCODE = '23514',
        DETAIL = format('revision=%s status=%s', v_current.id, v_current.status);
    END IF;

    -- Supersede, preserving the approval record (M209 approval-pair CHECK
    -- allows approved_by/approved_at to persist through 'superseded').
    UPDATE public.central_needs_plan_revisions
       SET status = 'superseded'
     WHERE id = v_current.id;
  END IF;

  INSERT INTO public.central_needs_plan_revisions (
    plan_id, organization_id, revision_number, status, created_by
  ) VALUES (
    v_plan.id, p_organization_id, COALESCE(v_current.revision_number, 0) + 1, 'draft', v_actor
  )
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    p_organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.open', 'central_needs_plan_revision', v_new.id,
    format('plan %s revision %s', p_plan_year, v_new.revision_number),
    jsonb_build_object(
      'plan_id', v_plan.id,
      'plan_year', p_plan_year,
      'revision_number', v_new.revision_number,
      'superseded_revision_id', CASE WHEN v_current.id IS NOT NULL AND p_supersede THEN v_current.id END
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'plan_id', v_plan.id, 'plan_revision_id', v_new.id,
    'revision_number', v_new.revision_number, 'status', v_new.status,
    'superseded_revision_id', CASE WHEN v_current.id IS NOT NULL AND p_supersede THEN v_current.id END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean) TO authenticated;

-- ============================================================================
-- 6. RPC — start an import session (import-session persistence).
--
--    Registers the immutable source-file evidence and opens a 'processing'
--    session carrying the PROVISIONAL browser digest. Nothing here finalizes
--    anything: the session is explicitly not trusted until the authoritative
--    replay agrees (see the finalize RPC).
--
--    Identity is deterministic and contract-derived: (revision, file SHA-256).
--    A replayed call for the same file on the same revision returns the
--    existing session rather than forking the evidence.
-- ============================================================================
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
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_revision    public.central_needs_plan_revisions%ROWTYPE;
  v_source_file public.central_needs_source_files%ROWTYPE;
  v_session     public.central_needs_import_sessions%ROWTYPE;
  v_filename    text := NULLIF(btrim(p_original_filename), '');
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

  PERFORM pg_advisory_xact_lock(hashtextextended(p_plan_revision_id::text || ':' || p_file_hash, 210002));

  SELECT * INTO v_source_file
    FROM public.central_needs_source_files
   WHERE plan_revision_id = p_plan_revision_id AND file_hash = p_file_hash;

  IF FOUND THEN
    SELECT * INTO v_session
      FROM public.central_needs_import_sessions
     WHERE plan_revision_id = p_plan_revision_id AND source_file_id = v_source_file.id
     ORDER BY started_at DESC
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true, 'idempotent_replay', true,
        'import_session_id', v_session.id, 'source_file_id', v_source_file.id,
        'status', v_session.status
      );
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
    started_by, preview_digest, parser_identity
  ) VALUES (
    p_plan_revision_id, v_revision.organization_id, v_source_file.id, 'processing',
    v_actor, p_preview_digest, p_parser_identity
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
      'parser_identity', p_parser_identity
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'import_session_id', v_session.id, 'source_file_id', v_source_file.id,
    'status', v_session.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_start_import_session(uuid, text, text, text, jsonb, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_start_import_session(uuid, text, text, text, jsonb, bigint, text) TO authenticated;

-- ============================================================================
-- 7. Internal: the canonical semantic digest, computed BY THE DATABASE over
--    the rows actually persisted for a session.
--
--    This is the heart of the trust boundary. It is deliberately NOT a value
--    any caller supplies: it is recomputed from `central_needs_source_records`
--    itself, so an authoritative digest can only ever describe evidence that
--    is really in the table.
--
--    CANONICAL FORM (stable contract — a client that wants its provisional
--    preview digest to match MUST reproduce exactly this):
--      * rows for the session, ordered by (target_entity, field_name) under
--        the bytewise "C" collation so ordering never depends on lc_collate;
--      * each row rendered as
--            target_entity || U+001F || field_name || U+001F || <source_values>
--        where <source_values> is PostgreSQL's own canonical jsonb text
--        (`jsonb::text`: object keys ordered, duplicate keys already removed,
--        one space after each colon);
--      * rows joined with U+001E;
--      * SHA-256 over the UTF-8 bytes, lowercase hex.
--    An empty record set digests the empty string, which is why finalization
--    separately refuses a session that persisted nothing.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_semantic_digest_v1(
  p_import_session_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT encode(
    sha256(
      convert_to(
        COALESCE(
          string_agg(
            r.target_entity || E'\x1F' || r.field_name || E'\x1F' || r.source_values::text,
            E'\x1E' ORDER BY r.target_entity COLLATE "C", r.field_name COLLATE "C"
          ),
          ''
        ),
        'UTF8'
      )
    ),
    'hex'
  )
  FROM public.central_needs_source_records r
  WHERE r.import_session_id = p_import_session_id;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_semantic_digest_v1(uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_semantic_digest_v1(uuid) IS
  'CN-1B internal: recomputes the canonical semantic digest over the source records actually persisted for an import session. Never accepts a caller-supplied digest.';

-- ============================================================================
-- 8. TRUSTED RPC — authoritative Node replay.
--
--    THIS IS THE ONLY PATH THAT MAY WRITE AUTHORITATIVE IMPORT EVIDENCE, AND
--    THE ONLY PATH TO status = 'completed'.
--
--    WHY service_role AND NOT A NEW DEDICATED ROLE
--      Migration 109 (`ALTER DEFAULT PRIVILEGES FOR ROLE postgres ... GRANT
--      EXECUTE ON FUNCTIONS TO service_role`, with EXECUTE revoked from
--      authenticated/anon/PUBLIC) already makes every function `postgres`
--      creates EXECUTE-able by service_role alone. service_role is this
--      repository's established trusted-backend identity — the same choice
--      migration 163 made for the outbox consumer's claim/complete/fail RPCs,
--      and for the same stated reason: it is the identity a server-side
--      worker holding the service-role key authenticates as. A dedicated
--      NOLOGIN role (as migration 141 invented for the demo purger) is
--      reserved for unusually dangerous one-off operations; an ordinary
--      trusted-backend RPC does not warrant one. The explicit REVOKE below is
--      belt-and-suspenders on top of 109's defaults, matching this
--      repository's universal convention.
--
--    WHY THE CALLER'S DIGEST IS NOT TRUSTED
--      An earlier revision of this migration accepted `p_authoritative_digest`
--      and `p_parser_identity` from an ordinary authenticated caller and
--      merely checked that the digest equalled the preview digest and that the
--      identity said `runtime: 'node'`. Both are caller-controlled claims, so
--      that check proved nothing: any holder of central_needs.import could
--      assert both and finalize arbitrary evidence. It was replaced by this
--      design. Here the trusted worker supplies the RECORDS, the database
--      writes them itself, and the database then recomputes the digest over
--      exactly those rows. No caller ever supplies an authoritative digest.
--
--    The provisional browser preview digest is still compared — that is
--    CN-2A's semantic-agreement requirement, and a divergence between what the
--    browser previewed and what Node actually produced must abort the import.
--    But it is a QUALITY gate, not the security boundary: the security
--    boundary is that only service_role reaches this function at all.
--
--    Finalization happens inside this same transaction rather than through a
--    separate public RPC, so there is no client-reachable surface that can
--    move a session to 'completed'.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_apply_authoritative_replay(
  p_import_session_id  uuid,
  p_source_file_sha256 text,
  p_records            jsonb,
  p_parser_identity    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session   public.central_needs_import_sessions%ROWTYPE;
  v_revision  public.central_needs_plan_revisions%ROWTYPE;
  v_file_hash text;
  v_inserted  bigint := 0;
  v_supplied  bigint;
  v_digest    text;
BEGIN
  IF p_import_session_id IS NULL THEN
    RAISE EXCEPTION 'import_session_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_source_file_sha256 IS NULL OR p_source_file_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'source_file_sha256_must_be_lowercase_sha256_hex' USING ERRCODE = '23514';
  END IF;
  IF p_records IS NULL OR jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'records_array_required' USING ERRCODE = '23514';
  END IF;
  IF p_parser_identity IS NULL OR jsonb_typeof(p_parser_identity) <> 'object' THEN
    RAISE EXCEPTION 'parser_identity_object_required' USING ERRCODE = '23514';
  END IF;

  -- The authoritative pass must be the Node runtime. Unlike the previous
  -- design this is not the security control — only service_role can be here
  -- at all — but a trusted worker that mislabels its own runtime is a bug
  -- worth failing closed on.
  IF COALESCE(p_parser_identity->>'runtime', '') <> 'node' THEN
    RAISE EXCEPTION 'authoritative_pass_must_be_node_runtime' USING ERRCODE = '23514',
      DETAIL = format('runtime=%s', COALESCE(p_parser_identity->>'runtime', '<absent>'));
  END IF;

  SELECT * INTO v_session
    FROM public.central_needs_import_sessions
   WHERE id = p_import_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'import_session_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_session.status <> 'processing' THEN
    RAISE EXCEPTION 'import_session_not_open' USING ERRCODE = '23514',
      DETAIL = format('session=%s status=%s', p_import_session_id, v_session.status);
  END IF;

  v_revision := public._phoenix_central_needs_load_revision_v1(v_session.plan_revision_id);
  PERFORM public._phoenix_central_needs_assert_draft_v1(v_session.plan_revision_id, v_revision.status);

  -- Bind the replay to the exact file the session was opened for. A replay of
  -- a different workbook can never be applied to this session.
  SELECT file_hash INTO v_file_hash
    FROM public.central_needs_source_files
   WHERE id = v_session.source_file_id;
  IF v_file_hash IS DISTINCT FROM p_source_file_sha256 THEN
    RAISE EXCEPTION 'authoritative_replay_source_file_mismatch' USING ERRCODE = '23514',
      DETAIL = format('session_file=%s replay_file=%s', v_file_hash, p_source_file_sha256),
      HINT = 'The replay was produced from a different workbook than this session references.';
  END IF;

  IF v_session.preview_digest IS NULL THEN
    RAISE EXCEPTION 'import_session_has_no_preview_digest' USING ERRCODE = '23514';
  END IF;

  v_supplied := jsonb_array_length(p_records);
  IF v_supplied = 0 THEN
    RAISE EXCEPTION 'authoritative_replay_produced_no_records' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_records) AS r
    WHERE jsonb_typeof(r) <> 'object'
       OR COALESCE(btrim(r->>'targetEntity'), '') = ''
       OR COALESCE(btrim(r->>'fieldName'), '') = ''
       OR NOT (r ? 'sourceValues')
  ) THEN
    RAISE EXCEPTION 'record_requires_target_entity_field_name_and_source_values' USING ERRCODE = '23514';
  END IF;

  -- The trusted replay writes the immutable evidence itself. There is no
  -- client-facing path that inserts into central_needs_source_records.
  WITH ins AS (
    INSERT INTO public.central_needs_source_records (
      import_session_id, organization_id, target_entity, field_name,
      source_values, source_provenance, created_by
    )
    SELECT
      p_import_session_id, v_session.organization_id,
      btrim(r->>'targetEntity'), btrim(r->>'fieldName'),
      r->'sourceValues',
      CASE WHEN r ? 'sourceProvenance' THEN r->'sourceProvenance' END,
      v_session.started_by
    FROM jsonb_array_elements(p_records) AS r
    ON CONFLICT (import_session_id, target_entity, field_name) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  -- Recompute the digest over exactly what is now persisted. This value is
  -- the database's own, never the caller's.
  v_digest := public._phoenix_central_needs_semantic_digest_v1(p_import_session_id);

  -- CN-2A semantic agreement: what the browser previewed must be what the
  -- authoritative replay actually produced.
  IF v_digest <> v_session.preview_digest THEN
    RAISE EXCEPTION 'authoritative_replay_semantic_mismatch' USING ERRCODE = '23514',
      DETAIL = format('preview=%s recomputed=%s', v_session.preview_digest, v_digest),
      HINT = 'The authoritative replay did not reproduce the browser preview. The import was not finalized.';
  END IF;

  UPDATE public.central_needs_import_sessions
     SET status = 'completed',
         completed_at = now(),
         authoritative_digest = v_digest,
         parser_identity = p_parser_identity
   WHERE id = p_import_session_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_session.organization_id, NULL, 'service_role',
    'central_needs.import_session.authoritative_replay', 'central_needs_import_session',
    p_import_session_id, NULL,
    jsonb_build_object(
      'plan_revision_id', v_session.plan_revision_id,
      'source_file_id', v_session.source_file_id,
      'source_file_sha256', p_source_file_sha256,
      'preview_digest', v_session.preview_digest,
      'authoritative_digest', v_digest,
      'parser_identity', p_parser_identity,
      'records_supplied', v_supplied,
      'records_inserted', v_inserted
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'import_session_id', p_import_session_id,
    'status', 'completed',
    'authoritative_digest', v_digest,
    'records_supplied', v_supplied,
    'records_inserted', v_inserted
  );
END;
$$;

-- Trusted surface: EXECUTE for service_role only (109's default privilege),
-- explicitly revoked from every client role. Deliberately NOT granted to
-- authenticated.
REVOKE ALL ON FUNCTION public.phoenix_central_needs_apply_authoritative_replay(uuid, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_apply_authoritative_replay(uuid, text, jsonb, jsonb) IS
  'CN-1B trusted backend RPC (service_role only): applies a Node 22 authoritative replay — writes the immutable source evidence, recomputes the canonical semantic digest over exactly those rows, enforces agreement with the provisional browser preview, and finalizes the session. Not executable by anon or authenticated.';

-- ============================================================================
-- 9. RPC — canonical-link (mapping) write.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_set_record_mapping(
  p_plan_revision_id uuid,
  p_target_entity    text,
  p_central_item_id  uuid
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
  v_entity      text := NULLIF(btrim(p_target_entity), '');
  v_existing    public.central_needs_record_mappings%ROWTYPE;
  v_row         public.central_needs_record_mappings%ROWTYPE;
  v_item_label  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF v_entity IS NULL THEN
    RAISE EXCEPTION 'target_entity_required' USING ERRCODE = '23514';
  END IF;
  IF p_central_item_id IS NULL THEN
    RAISE EXCEPTION 'central_item_id_required' USING ERRCODE = '23514';
  END IF;

  v_revision   := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);
  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.edit');
  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_revision.status);

  SELECT name INTO v_item_label FROM public.central_items WHERE id = p_central_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'central_item_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing
    FROM public.central_needs_record_mappings
   WHERE plan_revision_id = p_plan_revision_id AND target_entity = v_entity
   FOR UPDATE;

  IF FOUND AND v_existing.central_item_id = p_central_item_id THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'mapping_id', v_existing.id, 'target_entity', v_entity, 'central_item_id', p_central_item_id
    );
  END IF;

  INSERT INTO public.central_needs_record_mappings (
    plan_revision_id, organization_id, target_entity, central_item_id, mapped_by
  ) VALUES (
    p_plan_revision_id, v_revision.organization_id, v_entity, p_central_item_id, v_actor
  )
  ON CONFLICT (plan_revision_id, target_entity) DO UPDATE
    SET central_item_id = EXCLUDED.central_item_id,
        mapped_by       = EXCLUDED.mapped_by
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.record_mapping.set', 'central_needs_record_mapping', v_row.id,
    v_item_label,
    jsonb_build_object(
      'plan_revision_id', p_plan_revision_id,
      'target_entity', v_entity,
      'central_item_id', p_central_item_id,
      'previous_central_item_id', v_existing.central_item_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'mapping_id', v_row.id, 'target_entity', v_entity,
    'central_item_id', p_central_item_id,
    'previous_central_item_id', v_existing.central_item_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_set_record_mapping(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_set_record_mapping(uuid, text, uuid) TO authenticated;

-- ============================================================================
-- 10. RPC — reasoned field override.
--
--     Records a business correction WITHOUT touching source evidence. The
--     previous value is captured from the override ledger's own most recent
--     entry when one exists, otherwise from the immutable source record, so
--     the ledger reads as a continuous chain. A reason is mandatory (M209's
--     own NOT NULL + length CHECK; re-asserted here to produce a precise
--     error rather than a raw constraint violation).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_record_field_override(
  p_plan_revision_id   uuid,
  p_target_entity      text,
  p_field_name         text,
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
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_revision    public.central_needs_plan_revisions%ROWTYPE;
  v_entity      text := NULLIF(btrim(p_target_entity), '');
  v_field       text := NULLIF(btrim(p_field_name), '');
  v_reason      text := NULLIF(btrim(p_override_reason), '');
  v_previous    jsonb;
  v_row         public.central_needs_field_overrides%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF v_entity IS NULL THEN
    RAISE EXCEPTION 'target_entity_required' USING ERRCODE = '23514';
  END IF;
  IF v_field IS NULL THEN
    RAISE EXCEPTION 'field_name_required' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'override_reason_required' USING ERRCODE = '23514',
      HINT = 'A business override must record why it was made.';
  END IF;

  v_revision   := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);
  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.edit');
  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_revision.status);

  -- Chain from the latest prior override for this field if one exists...
  SELECT o.final_value INTO v_previous
    FROM public.central_needs_field_overrides o
   WHERE o.plan_revision_id = p_plan_revision_id
     AND o.target_entity = v_entity
     AND o.field_name = v_field
   ORDER BY o.created_at DESC
   LIMIT 1;

  -- ...otherwise from the immutable source evidence, which is READ here and
  -- never written. The source record keeps its original imported value
  -- regardless of how many overrides accumulate on top of it.
  IF v_previous IS NULL THEN
    SELECT sr.source_values INTO v_previous
      FROM public.central_needs_source_records sr
      JOIN public.central_needs_import_sessions s ON s.id = sr.import_session_id
     WHERE s.plan_revision_id = p_plan_revision_id
       AND sr.target_entity = v_entity
       AND sr.field_name = v_field
     ORDER BY sr.created_at DESC
     LIMIT 1;
  END IF;

  INSERT INTO public.central_needs_field_overrides (
    plan_revision_id, organization_id, target_entity, field_name,
    previous_value, final_value, override_reason, override_note, override_reference, actor_id
  ) VALUES (
    p_plan_revision_id, v_revision.organization_id, v_entity, v_field,
    v_previous, p_final_value, v_reason,
    NULLIF(btrim(p_override_note), ''), NULLIF(btrim(p_override_reference), ''), v_actor
  )
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.field_override.record', 'central_needs_field_override', v_row.id,
    v_entity,
    jsonb_build_object(
      'plan_revision_id', p_plan_revision_id,
      'target_entity', v_entity,
      'field_name', v_field,
      'override_reason', v_reason,
      'override_reference', NULLIF(btrim(p_override_reference), '')
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'override_id', v_row.id,
    'target_entity', v_entity, 'field_name', v_field,
    'previous_value', v_previous, 'final_value', p_final_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_record_field_override(uuid, text, text, jsonb, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_record_field_override(uuid, text, text, jsonb, text, text, text) TO authenticated;

-- ============================================================================
-- 11. RPC — submit a revision for review (draft -> submitted).
-- ============================================================================
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
  v_completed  bigint;
BEGIN
  v_revision   := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);
  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.edit');
  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_revision.status);

  -- A revision with no authoritatively finalized import has nothing to
  -- review. This is what stops a provisional, browser-only result from
  -- travelling any further through the workflow.
  SELECT count(*) INTO v_completed
    FROM public.central_needs_import_sessions
   WHERE plan_revision_id = p_plan_revision_id AND status = 'completed';
  IF v_completed = 0 THEN
    RAISE EXCEPTION 'plan_revision_has_no_finalized_import' USING ERRCODE = '23514',
      HINT = 'Finalize an import with an authoritative Node replay before submitting the revision for review.';
  END IF;

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
      'finalized_import_count', v_completed
    )
  );

  RETURN jsonb_build_object('ok', true, 'plan_revision_id', p_plan_revision_id, 'status', 'submitted');
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_submit_revision(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_submit_revision(uuid) TO authenticated;

-- ============================================================================
-- 12. RPC — approve a revision (submitted -> approved). Requires
--     central_needs.approve specifically; central_needs.edit is NOT enough.
--
--     Atomic: the status flip and the approver stamp are one UPDATE, and
--     M209's approval-pair CHECK makes an 'approved' row without an approver
--     impossible, so a partially-applied approval cannot exist.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_approve_revision(
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
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_revision_id IS NULL THEN
    RAISE EXCEPTION 'plan_revision_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_revision
    FROM public.central_needs_plan_revisions
   WHERE id = p_plan_revision_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.approve');

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

  UPDATE public.central_needs_plan_revisions
     SET status = 'approved', approved_by = v_actor, approved_at = now()
   WHERE id = p_plan_revision_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.approve', 'central_needs_plan_revision', p_plan_revision_id,
    format('revision %s', v_revision.revision_number),
    jsonb_build_object(
      'plan_id', v_revision.plan_id,
      'revision_number', v_revision.revision_number,
      'from_status', 'submitted', 'to_status', 'approved'
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'plan_revision_id', p_plan_revision_id, 'status', 'approved'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_approve_revision(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_approve_revision(uuid) TO authenticated;

-- ============================================================================
-- 13. RPC — reject a revision (submitted -> rejected). Rejecting is the other
--     half of the same review decision as approving, so it requires the same
--     central_needs.approve authority; central_needs.edit is NOT enough.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_reject_revision(
  p_plan_revision_id uuid,
  p_reason           text
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
  v_reason     text := NULLIF(btrim(p_reason), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_revision_id IS NULL THEN
    RAISE EXCEPTION 'plan_revision_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'rejection_reason_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_revision
    FROM public.central_needs_plan_revisions
   WHERE id = p_plan_revision_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.approve');

  IF v_revision.status <> 'submitted' THEN
    RAISE EXCEPTION 'plan_revision_not_submitted' USING ERRCODE = '23514',
      DETAIL = format('revision=%s status=%s', p_plan_revision_id, v_revision.status),
      HINT = 'Only a submitted revision can be rejected.';
  END IF;

  UPDATE public.central_needs_plan_revisions
     SET status = 'rejected'
   WHERE id = p_plan_revision_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.reject', 'central_needs_plan_revision', p_plan_revision_id,
    format('revision %s', v_revision.revision_number),
    jsonb_build_object(
      'plan_id', v_revision.plan_id,
      'revision_number', v_revision.revision_number,
      'from_status', 'submitted', 'to_status', 'rejected',
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'plan_revision_id', p_plan_revision_id, 'status', 'rejected'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_reject_revision(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_reject_revision(uuid, text) TO authenticated;

-- ============================================================================
-- VERIFY
-- ============================================================================
DO $verify$
DECLARE
  f text;
  v_sig text;
BEGIN
  -- 1. The mapping table exists with RLS enabled AND forced.
  IF to_regclass('public.central_needs_record_mappings') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): central_needs_record_mappings is missing';
  END IF;
  IF NOT (
    SELECT relrowsecurity AND relforcerowsecurity
    FROM pg_class WHERE oid = 'public.central_needs_record_mappings'::regclass
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): central_needs_record_mappings does not have RLS enabled+forced';
  END IF;

  -- 2. The trust-gate constraint exists.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'central_needs_import_sessions_authoritative_finalization_chk'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): the authoritative finalization CHECK is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'central_needs_record_mappings_revision_org_fk'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): the mapping composite FK is missing';
  END IF;

  -- 3. Every client-facing RPC exists, is SECURITY DEFINER, has a hardened
  --    search_path, and is executable by authenticated but not by PUBLIC/anon.
  FOREACH f IN ARRAY ARRAY[
    'public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean)',
    'public.phoenix_central_needs_start_import_session(uuid, text, text, text, jsonb, bigint, text)',
    'public.phoenix_central_needs_set_record_mapping(uuid, text, uuid)',
    'public.phoenix_central_needs_record_field_override(uuid, text, text, jsonb, text, text, text)',
    'public.phoenix_central_needs_submit_revision(uuid)',
    'public.phoenix_central_needs_approve_revision(uuid)',
    'public.phoenix_central_needs_reject_revision(uuid, text)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED (210): RPC % is missing', f;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION 'VERIFY FAILED (210): RPC % is not SECURITY DEFINER', f;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc, unnest(proconfig) AS c
      WHERE oid = to_regprocedure(f) AND c LIKE 'search_path=%'
    ) THEN
      RAISE EXCEPTION 'VERIFY FAILED (210): RPC % has no pinned search_path', f;
    END IF;
    IF EXISTS (
      SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = to_regprocedure(f)))
      WHERE grantee = 0 AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'VERIFY FAILED (210): PUBLIC still has EXECUTE on %', f;
    END IF;
    IF EXISTS (
      SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = to_regprocedure(f)))
      WHERE grantee = 'anon'::regrole AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'VERIFY FAILED (210): anon still has EXECUTE on %', f;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = to_regprocedure(f)))
      WHERE grantee = 'authenticated'::regrole AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'VERIFY FAILED (210): authenticated cannot EXECUTE %', f;
    END IF;
  END LOOP;

  -- 3b. The TRUSTED replay RPC: reachable by service_role ONLY. This is the
  --     security boundary of the whole import path, so it is asserted
  --     positively (service_role can) and negatively (nobody else can).
  f := 'public.phoenix_central_needs_apply_authoritative_replay(uuid, text, jsonb, jsonb)';
  IF to_regprocedure(f) IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): the trusted authoritative-replay RPC is missing';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(f)) THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): the trusted replay RPC is not SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc, unnest(proconfig) AS c
    WHERE oid = to_regprocedure(f) AND c LIKE 'search_path=%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): the trusted replay RPC has no pinned search_path';
  END IF;
  FOREACH v_sig IN ARRAY ARRAY['0', 'anon', 'authenticated'] LOOP
    IF EXISTS (
      SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = to_regprocedure(f)))
      WHERE privilege_type = 'EXECUTE'
        AND grantee = (CASE WHEN v_sig = '0' THEN 0 ELSE v_sig::regrole END)
    ) THEN
      RAISE EXCEPTION 'VERIFY FAILED (210): % can EXECUTE the trusted replay RPC',
        CASE WHEN v_sig = '0' THEN 'PUBLIC' ELSE v_sig END;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', to_regprocedure(f), 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): service_role cannot EXECUTE the trusted replay RPC';
  END IF;

  -- 4. The internal helpers are NOT client-callable.
  FOREACH f IN ARRAY ARRAY[
    'public._phoenix_central_needs_semantic_digest_v1(uuid)',
    'public._phoenix_central_needs_guard_v1(uuid, text)',
    'public._phoenix_central_needs_load_revision_v1(uuid)',
    'public._phoenix_central_needs_assert_draft_v1(uuid, text)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED (210): internal helper % is missing', f;
    END IF;
    IF EXISTS (
      SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = to_regprocedure(f)))
      WHERE grantee IN (0, 'anon'::regrole, 'authenticated'::regrole) AND privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'VERIFY FAILED (210): internal helper % is client-callable', f;
    END IF;
  END LOOP;

  -- 5. The permission surface is unchanged: still exactly four central_needs
  --    keys, still zero default role grants, and still no send permission.
  IF (SELECT count(*) FROM public.permission_keys WHERE module = 'central_needs') <> 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): the central_needs permission key count changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.permission_keys WHERE key = 'central_needs.send') THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): central_needs.send must never exist';
  END IF;
  IF EXISTS (SELECT 1 FROM public.role_permission_defaults WHERE permission_key LIKE 'central_needs.%') THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): central_needs.* must keep zero default role grants';
  END IF;

  -- 6. No client write grant leaked onto any Central Needs table.
  FOREACH f IN ARRAY ARRAY[
    'central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files',
    'central_needs_import_sessions', 'central_needs_source_records',
    'central_needs_field_overrides', 'central_needs_record_mappings'
  ] LOOP
    FOREACH v_sig IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege('authenticated', 'public.' || f, v_sig) THEN
        RAISE EXCEPTION 'VERIFY FAILED (210): authenticated holds % on %', v_sig, f;
      END IF;
      IF has_table_privilege('anon', 'public.' || f, v_sig) THEN
        RAISE EXCEPTION 'VERIFY FAILED (210): anon holds % on %', v_sig, f;
      END IF;
    END LOOP;
  END LOOP;
END;
$verify$;

COMMIT;

-- ============================================================================
-- ROLLBACK (documentation only — not executed):
--
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.phoenix_central_needs_reject_revision(uuid, text);
--   DROP FUNCTION IF EXISTS public.phoenix_central_needs_approve_revision(uuid);
--   DROP FUNCTION IF EXISTS public.phoenix_central_needs_submit_revision(uuid);
--   DROP FUNCTION IF EXISTS public.phoenix_central_needs_record_field_override(uuid, text, text, jsonb, text, text, text);
--   DROP FUNCTION IF EXISTS public.phoenix_central_needs_set_record_mapping(uuid, text, uuid);
--   DROP FUNCTION IF EXISTS public.phoenix_central_needs_apply_authoritative_replay(uuid, text, jsonb, jsonb);
--   DROP FUNCTION IF EXISTS public._phoenix_central_needs_semantic_digest_v1(uuid);
--   DROP FUNCTION IF EXISTS public.phoenix_central_needs_start_import_session(uuid, text, text, text, jsonb, bigint, text);
--   DROP FUNCTION IF EXISTS public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean);
--   DROP FUNCTION IF EXISTS public._phoenix_central_needs_assert_draft_v1(uuid, text);
--   DROP FUNCTION IF EXISTS public._phoenix_central_needs_load_revision_v1(uuid);
--   DROP FUNCTION IF EXISTS public._phoenix_central_needs_guard_v1(uuid, text);
--   DROP TABLE IF EXISTS public.central_needs_record_mappings;
--   ALTER TABLE public.central_needs_import_sessions
--     DROP CONSTRAINT IF EXISTS central_needs_import_sessions_authoritative_finalization_chk,
--     DROP CONSTRAINT IF EXISTS central_needs_import_sessions_authoritative_digest_chk,
--     DROP CONSTRAINT IF EXISTS central_needs_import_sessions_preview_digest_chk,
--     DROP COLUMN IF EXISTS parser_identity,
--     DROP COLUMN IF EXISTS authoritative_digest,
--     DROP COLUMN IF EXISTS preview_digest;
--   COMMIT;
-- ============================================================================
