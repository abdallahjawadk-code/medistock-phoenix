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
--   2. A deterministic relational identity for source evidence
--      (central_needs_source_records.record_ordinal) that replaces M209's
--      (session, target_entity, field_name) uniqueness.
--   3. Explicit override lineage (central_needs_field_overrides
--      .source_record_id) so a correction always names the exact evidence it
--      corrects.
--   4. One table, central_needs_record_mappings — the canonical-link surface,
--      scoped to an import session so multi-file intake cannot collide.
--   5. Seven client-facing SECURITY DEFINER workflow RPCs.
--   6. ONE trusted-backend RPC, reachable by service_role only, which is the
--      sole path that may write authoritative import evidence or move a
--      session to 'completed'.
--
-- WHY THE IDENTITY WORK (2) IS NECESSARY, NOT COSMETIC
--   CN-2A's frozen contract emits targetEntity as "sheet:{index}:row:{row}"
--   and fieldName as the workbook's own header text. Neither is unique inside
--   a plan revision:
--     * two source files under one revision (ZIP / multi-file intake) both
--       legitimately contain sheet:0:row:5;
--     * one row legitimately carries two columns with the SAME header text.
--   M209's UNIQUE (import_session_id, target_entity, field_name) therefore
--   cannot represent real workbooks: the second same-header cell in a row has
--   nowhere to go, and an ON CONFLICT DO NOTHING writer would silently drop
--   it — losing immutable evidence while reporting success.
--
--   The fix stays PARSER-NEUTRAL. It does not add sheet/row/column columns and
--   does not reinterpret targetEntity or fieldName, both of which remain
--   opaque text exactly as CN-2A froze them. It adds one integer, the
--   position of the record inside CN-2A's already-deterministic sourceRecords
--   array, captured with WITH ORDINALITY at insert time. Uniqueness becomes
--   (import_session_id, record_ordinal): every emitted record is preserved,
--   duplicates included, and each is independently addressable. Multi-file
--   collision disappears because ordinals are per session, and a session is
--   per source file.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   - No stock mutation, no movement ledger, no transfer request of any kind,
--     no touch of inventory_transfer_suggestions. Central Needs planning and
--     physical sending stay separate systems; physical sending remains
--     governed by warehouse_transfer.send and is not referenced here.
--   - No new permission key. The four M209 keys are the complete surface.
--     There is deliberately NO central_needs.send.
--   - No new default role grant. central_needs.* keeps zero rows in
--     role_permission_defaults.
--   - No parallel authorization framework. Every client guard composes the
--     existing public.phoenix_status_center_authorized (M092), which M209's
--     own header names as mandatory for CN-1B.
--   - No trigger-based audit framework. Every audit row is an explicit INSERT
--     inside an RPC body.
--   - No change to M201/M202. Central Needs objects are NOT added to the
--     organizations archive reciprocal dependency set; instead every mutating
--     path refuses NEW activity under an archived organization.
--
-- THE CN-2A TRUST BOUNDARY
--   CN-2A produces a parse result in one of two runtimes: a provisional
--   browser Worker preview, and an authoritative Node 22 replay keyed by the
--   SHA-256 of the exact input bytes. A browser preview is attacker-influenced
--   and must never be sufficient to finalize an import.
--
--   EQUALITY OF TWO DIGESTS IS NOT THE BOUNDARY. It proves nothing if the same
--   principal supplies both. The boundary is WHO may write, and WHERE the
--   authoritative digest comes from:
--     * preview_digest is a PROVISIONAL client claim, written at session
--       start by a central_needs.import holder. Never sufficient.
--     * authoritative_digest is never accepted from any caller. It is
--       RECOMPUTED by the database (section 5) over the source records
--       actually persisted, inside the trusted replay transaction.
--     * Only service_role can reach that transaction (section 7), and only
--       that transaction inserts source records or sets status='completed'.
--
--   WHAT THE DIGEST BINDS
--   The digest covers the whole persisted evidence surface, not just values:
--   record_ordinal, target_entity, field_name, source_values AND
--   source_provenance. Provenance is immutable source evidence and part of
--   CN-2A's frozen SourceValueRecordDraft, so a replay with identical values
--   but a different sheet, coordinate or origin file is a DIFFERENT import and
--   fails agreement. Exactly one field is normalized away before hashing:
--   SourceProvenance.extractedAt, the documented runtime-parity exception —
--   it records when the parse ran, so browser and Node necessarily differ.
--   Every other provenance field is preserved and hashed.
--
--   SCOPE OF THIS EQUALITY — stated honestly. The database can only compare
--   what it persists. CN-2A's FileParseResult / ArchiveParseResult also carry
--   workbook totals, diagnostics, family detection and reconciliation
--   summaries, none of which M209 stores. Whole-result equality therefore
--   remains the trusted worker's responsibility, performed before it calls
--   this RPC. What the database proves is narrower and precisely stated:
--   the PERSISTED evidence is byte-equal to what the browser previewed, and
--   nothing else was written. That is the property finalization depends on.
--
-- IDEMPOTENCY / REPLAY SAFETY
--   Import identity is deterministic and contract-derived: a source file is
--   identified by its SHA-256 within a revision (M209 already declares
--   UNIQUE (plan_revision_id, file_hash)). The trusted replay is safe to
--   retry after a lost response: an exact retry of an already-completed
--   session (same file hash, same recomputed digest) returns
--   idempotent_replay = true and writes nothing, while a retry carrying
--   different evidence fails closed.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Preconditions — fail closed if M209's surface is not exactly as expected.
-- ----------------------------------------------------------------------------
DO $precondition$
DECLARE
  t text;
  n bigint;
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

  -- organizations.archived_at is M202's archive marker; every guard reads it.
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

  -- FAIL CLOSED ON UNEXPECTED PRE-M210 DATA.
  -- Sections 2 and 3 give source evidence and overrides a NOT NULL relational
  -- identity that did not exist before. M209 shipped no writer at all, so
  -- these tables must be empty; if they are not, some unknown path wrote rows
  -- whose lineage this migration cannot derive. Guessing an ordinal or a
  -- source_record_id would fabricate evidence lineage, so refuse instead.
  SELECT count(*) INTO n FROM public.central_needs_source_records;
  IF n > 0 THEN
    RAISE EXCEPTION '210_precondition_failed: central_needs_source_records holds % pre-M210 row(s); record_ordinal lineage cannot be derived deterministically', n;
  END IF;
  SELECT count(*) INTO n FROM public.central_needs_field_overrides;
  IF n > 0 THEN
    RAISE EXCEPTION '210_precondition_failed: central_needs_field_overrides holds % pre-M210 row(s); source_record_id lineage cannot be derived deterministically', n;
  END IF;
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
  'CN-1B: lowercase-hex SHA-256 recomputed BY THE DATABASE over the persisted source records. Never accepted from a caller. Must equal preview_digest before status may become ''completed''.';
COMMENT ON COLUMN public.central_needs_import_sessions.parser_identity IS
  'CN-1B: the upstream parser identity record of the authoritative pass (contract version, parser version, pinned artifact hash, runtime). Shape-free jsonb — the database asserts presence and the runtime field, never parser shape.';

-- ----------------------------------------------------------------------------
-- 2. Deterministic relational identity for source evidence.
--    See the header for why (session, target_entity, field_name) cannot work.
-- ----------------------------------------------------------------------------
ALTER TABLE public.central_needs_source_records
  ADD COLUMN record_ordinal integer NOT NULL,
  ADD CONSTRAINT central_needs_source_records_ordinal_positive_chk
    CHECK (record_ordinal > 0);

-- M209's uniqueness cannot represent two same-header cells in one row.
ALTER TABLE public.central_needs_source_records
  DROP CONSTRAINT central_needs_source_records_import_session_id_target_entit_key;

ALTER TABLE public.central_needs_source_records
  ADD CONSTRAINT central_needs_source_records_session_ordinal_key
    UNIQUE (import_session_id, record_ordinal),
  -- Exposed so central_needs_field_overrides can prove, in one composite FK,
  -- that the record it corrects belongs to the same organization it claims.
  ADD CONSTRAINT central_needs_source_records_id_org_key
    UNIQUE (id, organization_id);

COMMENT ON COLUMN public.central_needs_source_records.record_ordinal IS
  'CN-1B: 1-based position of this record inside CN-2A''s deterministic sourceRecords array for the session, captured WITH ORDINALITY. Parser-neutral relational identity — it encodes order only, never sheet/row/column structure.';

-- ----------------------------------------------------------------------------
-- 3. Override lineage — a correction always names the evidence it corrects.
-- ----------------------------------------------------------------------------
ALTER TABLE public.central_needs_field_overrides
  ADD COLUMN source_record_id uuid NOT NULL,
  ADD CONSTRAINT central_needs_field_overrides_source_record_org_fk
    FOREIGN KEY (source_record_id, organization_id)
    REFERENCES public.central_needs_source_records (id, organization_id)
    ON DELETE RESTRICT;

CREATE INDEX central_needs_field_overrides_source_record_idx
  ON public.central_needs_field_overrides(source_record_id);

COMMENT ON COLUMN public.central_needs_field_overrides.source_record_id IS
  'CN-1B: the exact authoritative source record this override corrects. NOT NULL, so no phantom field can be overridden and previous_value always has a real lineage to derive from.';

-- ----------------------------------------------------------------------------
-- 4. central_needs_record_mappings — the canonical-link surface.
--
--    Scoped to an IMPORT SESSION, not merely a plan revision: two source files
--    under one revision both legitimately contain sheet:0:row:1, and each must
--    stay independently mappable.
-- ----------------------------------------------------------------------------
CREATE TABLE public.central_needs_record_mappings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_session_id uuid NOT NULL,
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  target_entity     text NOT NULL CHECK (length(target_entity) > 0),
  central_item_id   uuid NOT NULL REFERENCES public.central_items(id) ON DELETE RESTRICT,
  mapped_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_session_id, target_entity),
  CONSTRAINT central_needs_record_mappings_session_org_fk
    FOREIGN KEY (import_session_id, organization_id)
    REFERENCES public.central_needs_import_sessions (id, organization_id)
    ON DELETE RESTRICT
);

CREATE INDEX central_needs_record_mappings_session_idx ON public.central_needs_record_mappings(import_session_id);
CREATE INDEX central_needs_record_mappings_org_idx     ON public.central_needs_record_mappings(organization_id);
CREATE INDEX central_needs_record_mappings_item_idx    ON public.central_needs_record_mappings(central_item_id);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.central_needs_record_mappings
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at();

COMMENT ON TABLE public.central_needs_record_mappings IS
  'CN-1B: canonical link from an imported target_entity to a central_items row, scoped to one import session so multi-file intake cannot collide. Mutable by design (a mapping is a correction, not source evidence). No client write path.';

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
-- 5. Internal helpers.
-- ----------------------------------------------------------------------------

-- 5a. Archived-organization denial, shared by the client guard AND the trusted
--     replay. It is deliberately SEPARATE from the authorization guard: the
--     trusted backend has no auth.uid() and must not be forced through a
--     client authorization check, but it is still absolutely subject to the
--     archived-organization rule. FOR KEY SHARE is the same concurrency fence
--     M202's reciprocal guard uses, so an archive cannot commit underneath an
--     in-flight mutation.
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_assert_org_live_v1(
  p_organization_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_archived_at timestamptz;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT archived_at INTO v_archived_at
    FROM public.organizations
   WHERE id = p_organization_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'central_needs_write_blocked_by_archived_organization'
      USING ERRCODE = '23514',
      DETAIL = format('organization=%s archived_at=%s', p_organization_id, v_archived_at),
      HINT = 'Restore the organization before creating or changing Central Needs data under it.';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_org_live_v1(uuid) FROM PUBLIC, anon, authenticated;

-- 5b. Client authorization guard: composes the canonical helper, then applies
--     the shared archive rule. Not a second authorization system.
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

  -- Organization existence (and the FOR KEY SHARE fence) comes first so a
  -- nonexistent organization is reported as such rather than as forbidden.
  PERFORM 1 FROM public.organizations WHERE id = p_organization_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
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

COMMENT ON FUNCTION public._phoenix_central_needs_guard_v1(uuid, text) IS
  'CN-1B internal: composes public.phoenix_status_center_authorized with organization existence and the shared archived-organization rule. Not a parallel authorization system and not client-callable.';

-- 5c. Resolve a revision, and (separately) assert it is editable. Two steps so
--     every RPC can run load -> authorize -> assert-editable, refusing an
--     unauthorized caller BEFORE disclosing the workflow state of a revision
--     they may not see.
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
      HINT = 'Only a draft revision accepts imported content, mappings and overrides. Open a new revision to change closed history.';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_draft_v1(uuid, text) FROM PUBLIC, anon, authenticated;

-- 5d. THE canonical semantic digest, computed BY THE DATABASE over the rows
--     actually persisted for a session. Never a caller-supplied value.
--
--     CANONICAL FORM (stable contract — a client whose provisional preview
--     digest must agree has to reproduce exactly this):
--       * rows for the session ordered by record_ordinal (deterministic, and
--         independent of any collation);
--       * each row rendered as
--           ordinal U+001F target_entity U+001F field_name U+001F
--           <source_values> U+001F <source_provenance minus extractedAt>
--         where <...> is PostgreSQL's canonical jsonb text (`jsonb::text`:
--         object keys ordered, duplicates removed, one space after each colon);
--       * rows joined with U+001E;
--       * SHA-256 over the UTF-8 bytes, lowercase hex.
--
--     extractedAt is the ONE documented runtime-parity exception: it records
--     when the parse ran, so the browser and Node passes necessarily differ.
--     Every other provenance field is preserved and hashed, so a replay with
--     identical values but a different sheet, coordinate or origin file fails
--     agreement.
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
            r.record_ordinal::text || E'\x1F' ||
            r.target_entity        || E'\x1F' ||
            r.field_name           || E'\x1F' ||
            r.source_values::text  || E'\x1F' ||
            COALESCE((r.source_provenance - 'extractedAt')::text, ''),
            E'\x1E' ORDER BY r.record_ordinal
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

-- 5e. Payload validation — the SINGLE structural/provenance gate, shared by
--     every path through the trusted replay.
--
--     It is one function precisely so the completed-session retry comparison
--     and the first-persistence path can never drift apart. An earlier revision
--     validated only on the persistence path and digested the payload BEFORE
--     validating on the retry path, which was exploitable: the canonical
--     expression concatenates fields, a malformed element yields NULL, and
--     string_agg silently DROPS a NULL member. Appending `{}` — or any element
--     missing a required field — therefore produced a digest identical to the
--     original payload's, and the retry was wrongly accepted as an exact
--     idempotent replay. Validation now runs before EITHER branch, so a
--     malformed payload is refused before it is ever hashed.
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_assert_payload_v1(
  p_records            jsonb,
  p_source_file_sha256 text
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_records IS NULL OR jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'records_array_required' USING ERRCODE = '23514';
  END IF;

  IF jsonb_array_length(p_records) = 0 THEN
    RAISE EXCEPTION 'authoritative_replay_produced_no_records' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_records) AS r
    WHERE jsonb_typeof(r) <> 'object'
       OR NOT (r ? 'targetEntity')
       OR COALESCE(btrim(r->>'targetEntity'), '') = ''
       OR NOT (r ? 'fieldName')
       OR COALESCE(btrim(r->>'fieldName'), '') = ''
       OR NOT (r ? 'sourceValues')
  ) THEN
    RAISE EXCEPTION 'record_requires_target_entity_field_name_and_source_values' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_records) AS r
    WHERE NOT (r ? 'sourceProvenance')
       OR jsonb_typeof(r->'sourceProvenance') <> 'object'
  ) THEN
    RAISE EXCEPTION 'record_requires_source_provenance_object' USING ERRCODE = '23514',
      HINT = 'Provenance is immutable source evidence and is bound into the semantic digest; it may not be omitted or null.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_records) AS r
    WHERE COALESCE(r->'sourceProvenance'->>'fileFingerprintSha256', '') <> p_source_file_sha256
  ) THEN
    RAISE EXCEPTION 'record_provenance_file_fingerprint_mismatch' USING ERRCODE = '23514',
      DETAIL = format('expected=%s', p_source_file_sha256),
      HINT = 'Every record''s provenance must fingerprint the same source file as the session.';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_payload_v1(jsonb, text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_assert_payload_v1(jsonb, text) IS
  'CN-1B internal: the single structural/provenance validation gate for a replay payload, run before BOTH the completed-session idempotency comparison and first persistence so the two paths cannot drift.';

-- 5f. The SAME canonical form, computed over a replay PAYLOAD rather than over
--     persisted rows. It exists for exactly one purpose: deciding whether a
--     retry against an already-completed session carries the same evidence.
--
--     Recomputing the persisted digest cannot answer that question — the
--     persisted rows do not change, so that digest always equals the stored
--     authoritative_digest and every retry would look idempotent no matter
--     what the caller sent. This function hashes what the caller actually
--     supplied, so a retry carrying different evidence is detected and
--     refused. It is never used for the agreement gate itself; that stays
--     bound to what is really in the table.
--
--     Every concatenated member is COALESCE'd to a non-NULL sentinel as
--     defence in depth. Section 5e already refuses a malformed payload before
--     this function is reached, but a NULL member would otherwise vanish
--     inside string_agg and make two different payloads hash alike. For a
--     VALID payload every COALESCE is a no-op, so the canonical form — and
--     therefore every digest this contract has ever produced — is unchanged.
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_payload_digest_v1(
  p_records jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT encode(
    sha256(
      convert_to(
        COALESCE(
          string_agg(
            e.ord::text                                              || E'\x1F' ||
            COALESCE(btrim(e.r->>'targetEntity'), '')                || E'\x1F' ||
            COALESCE(btrim(e.r->>'fieldName'), '')                   || E'\x1F' ||
            COALESCE((e.r->'sourceValues')::text, '')                || E'\x1F' ||
            COALESCE(((e.r->'sourceProvenance') - 'extractedAt')::text, ''),
            E'\x1E' ORDER BY e.ord
          ),
          ''
        ),
        'UTF8'
      )
    ),
    'hex'
  )
  FROM jsonb_array_elements(p_records) WITH ORDINALITY AS e(r, ord);
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_payload_digest_v1(jsonb)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_payload_digest_v1(jsonb) IS
  'CN-1B internal: the canonical semantic digest of a replay payload, used only to decide whether a retry against a completed session carries identical evidence. The agreement gate itself always hashes the persisted rows.';

COMMENT ON FUNCTION public._phoenix_central_needs_semantic_digest_v1(uuid) IS
  'CN-1B internal: recomputes the canonical semantic digest over the source records actually persisted for an import session, binding ordinal, entity, field, values and provenance (minus the extractedAt runtime-parity exception). Never accepts a caller-supplied digest.';

-- ============================================================================
-- 6. RPC — open a plan revision (revision workflow).
--
--    p_open_next_revision explains itself: FALSE (default) means "give me the
--    revision I should be working in", which succeeds only when the newest
--    revision is still a draft. TRUE means "the newest revision is CLOSED;
--    open the next one after it".
--
--    A closed revision is either 'approved' or 'rejected', and the two behave
--    differently on purpose:
--      * approved -> becomes 'superseded', KEEPING approved_by/approved_at
--        (M209's approval-pair CHECK explicitly permits that), so approved
--        history stays traceable;
--      * rejected -> stays 'rejected', untouched. A rejected revision is
--        history too, and rewriting it to 'superseded' would erase the fact
--        that it was refused. Without this branch a rejection would
--        permanently dead-end the plan year, since no new revision could ever
--        be opened.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_open_plan_revision(
  p_organization_id    uuid,
  p_plan_year          integer,
  p_open_next_revision boolean DEFAULT false
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
  v_closed     text;
BEGIN
  v_actor_role := public._phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.edit');

  IF p_plan_year IS NULL THEN
    RAISE EXCEPTION 'plan_year_required' USING ERRCODE = '23514';
  END IF;

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
    IF v_current.status = 'draft' THEN
      RETURN jsonb_build_object(
        'ok', true, 'idempotent_replay', true,
        'plan_id', v_plan.id, 'plan_revision_id', v_current.id,
        'revision_number', v_current.revision_number, 'status', v_current.status
      );
    END IF;

    IF v_current.status NOT IN ('approved', 'rejected') THEN
      RAISE EXCEPTION 'plan_revision_still_in_review' USING ERRCODE = '23514',
        DETAIL = format('revision=%s status=%s', v_current.id, v_current.status),
        HINT = 'Approve or reject the current revision before opening the next one.';
    END IF;

    IF NOT p_open_next_revision THEN
      RAISE EXCEPTION 'plan_revision_already_closed' USING ERRCODE = '23514',
        DETAIL = format('revision=%s status=%s', v_current.id, v_current.status),
        HINT = 'Pass p_open_next_revision => true to open the next revision after the closed one.';
    END IF;

    v_closed := v_current.status;

    -- Only an APPROVED revision is superseded. A rejected one keeps its
    -- rejection: it is history, not a superseded plan.
    IF v_current.status = 'approved' THEN
      UPDATE public.central_needs_plan_revisions
         SET status = 'superseded'
       WHERE id = v_current.id;
    END IF;
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
      'previous_revision_id', v_current.id,
      'previous_revision_closed_as', v_closed
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'plan_id', v_plan.id, 'plan_revision_id', v_new.id,
    'revision_number', v_new.revision_number, 'status', v_new.status,
    'previous_revision_id', v_current.id,
    'previous_revision_closed_as', v_closed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean) TO authenticated;

-- ============================================================================
-- 7. RPC — start an import session (client-facing, provisional).
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
-- 8. TRUSTED RPC — authoritative Node replay.
--
--    THIS IS THE ONLY PATH THAT MAY WRITE AUTHORITATIVE IMPORT EVIDENCE, AND
--    THE ONLY PATH TO status = 'completed'.
--
--    WHY service_role AND NOT A NEW DEDICATED ROLE
--      Migration 109 (`ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS
--      TO service_role`, with EXECUTE revoked from authenticated/anon/PUBLIC)
--      already makes every function `postgres` creates EXECUTE-able by
--      service_role alone. service_role is this repository's established
--      trusted-backend identity — the same choice migration 163 made for the
--      outbox consumer's claim/complete/fail RPCs, and for the same stated
--      reason. A dedicated NOLOGIN role (as migration 141 invented for the
--      demo purger) is reserved for unusually dangerous one-off operations.
--      The explicit REVOKE below is belt-and-suspenders on top of 109.
--
--    BEING TRUSTED IS NOT BEING EXEMPT. service_role bypasses RLS, but it does
--    NOT bypass the archived-organization rule: an organization archived
--    between session start and replay refuses the replay outright, before any
--    source record is written.
--
--    IDEMPOTENCY. A trusted worker whose response was lost may retry. An exact
--    retry of an already-completed session — same source file, same recomputed
--    digest — returns idempotent_replay = true and writes nothing at all. A
--    retry carrying different evidence fails closed.
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

  -- Trusted, but never exempt from the archive rule.
  PERFORM public._phoenix_central_needs_assert_org_live_v1(v_session.organization_id);

  SELECT file_hash INTO v_file_hash
    FROM public.central_needs_source_files
   WHERE id = v_session.source_file_id;
  IF v_file_hash IS DISTINCT FROM p_source_file_sha256 THEN
    RAISE EXCEPTION 'authoritative_replay_source_file_mismatch' USING ERRCODE = '23514',
      DETAIL = format('session_file=%s replay_file=%s', v_file_hash, p_source_file_sha256),
      HINT = 'The replay was produced from a different workbook than this session references.';
  END IF;

  -- Validate the payload BEFORE either branch. This must precede the
  -- completed-session comparison: digesting an unvalidated payload is exactly
  -- how a malformed appended element could hash as an identical retry.
  PERFORM public._phoenix_central_needs_assert_payload_v1(p_records, p_source_file_sha256);

  -- Lost-response retry: an EXACT repeat of a completed session is a no-op.
  -- The comparison hashes the SUPPLIED payload, not the persisted rows — the
  -- persisted rows never change, so hashing them would make every retry look
  -- identical regardless of what the caller actually sent.
  IF v_session.status = 'completed' THEN
    v_digest := public._phoenix_central_needs_payload_digest_v1(p_records);
    IF v_session.authoritative_digest IS NOT DISTINCT FROM v_digest THEN
      RETURN jsonb_build_object(
        'ok', true, 'idempotent_replay', true,
        'import_session_id', p_import_session_id, 'status', v_session.status,
        'authoritative_digest', v_session.authoritative_digest,
        'records_supplied', jsonb_array_length(p_records), 'records_inserted', 0
      );
    END IF;
    RAISE EXCEPTION 'import_session_already_finalized_with_different_evidence' USING ERRCODE = '23514';
  END IF;

  IF v_session.status <> 'processing' THEN
    RAISE EXCEPTION 'import_session_not_open' USING ERRCODE = '23514',
      DETAIL = format('session=%s status=%s', p_import_session_id, v_session.status);
  END IF;

  v_revision := public._phoenix_central_needs_load_revision_v1(v_session.plan_revision_id);
  PERFORM public._phoenix_central_needs_assert_draft_v1(v_session.plan_revision_id, v_revision.status);

  IF v_session.preview_digest IS NULL THEN
    RAISE EXCEPTION 'import_session_has_no_preview_digest' USING ERRCODE = '23514';
  END IF;

  -- Payload already validated above by the shared gate (section 5e).
  v_supplied := jsonb_array_length(p_records);

  -- The trusted replay writes the immutable evidence itself, preserving CN-2A's
  -- deterministic array order as record_ordinal. WITH ORDINALITY means every
  -- emitted record is kept — duplicate headers in one row included — instead of
  -- being silently collapsed.
  WITH ins AS (
    INSERT INTO public.central_needs_source_records (
      import_session_id, organization_id, record_ordinal, target_entity, field_name,
      source_values, source_provenance, created_by
    )
    SELECT
      p_import_session_id, v_session.organization_id, e.ord,
      btrim(e.r->>'targetEntity'), btrim(e.r->>'fieldName'),
      e.r->'sourceValues', e.r->'sourceProvenance',
      v_session.started_by
    FROM jsonb_array_elements(p_records) WITH ORDINALITY AS e(r, ord)
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  -- Recompute over exactly what is now persisted. The database's own value.
  v_digest := public._phoenix_central_needs_semantic_digest_v1(p_import_session_id);

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
    'ok', true, 'idempotent_replay', false,
    'import_session_id', p_import_session_id, 'status', 'completed',
    'authoritative_digest', v_digest,
    'records_supplied', v_supplied, 'records_inserted', v_inserted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_apply_authoritative_replay(uuid, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_apply_authoritative_replay(uuid, text, jsonb, jsonb) IS
  'CN-1B trusted backend RPC (service_role only): applies a Node 22 authoritative replay — writes the immutable source evidence with deterministic ordinals, recomputes the canonical semantic digest over exactly those rows, enforces agreement with the provisional browser preview, and finalizes the session. Refuses archived organizations. Idempotent on exact retry. Not executable by anon or authenticated.';

-- ============================================================================
-- 9. RPC — canonical-link (mapping) write.
--
--    Bound to one exact import-session entity: the target_entity must really
--    exist in that session's authoritative evidence, so no phantom entity can
--    be mapped.
-- ============================================================================
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
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_session    public.central_needs_import_sessions%ROWTYPE;
  v_revision   public.central_needs_plan_revisions%ROWTYPE;
  v_entity     text := NULLIF(btrim(p_target_entity), '');
  v_existing   public.central_needs_record_mappings%ROWTYPE;
  v_row        public.central_needs_record_mappings%ROWTYPE;
  v_item_label text;
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
  IF p_central_item_id IS NULL THEN
    RAISE EXCEPTION 'central_item_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_session
    FROM public.central_needs_import_sessions
   WHERE id = p_import_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'import_session_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_actor_role := public._phoenix_central_needs_guard_v1(v_session.organization_id, 'central_needs.edit');
  v_revision   := public._phoenix_central_needs_load_revision_v1(v_session.plan_revision_id);
  PERFORM public._phoenix_central_needs_assert_draft_v1(v_session.plan_revision_id, v_revision.status);

  -- No phantom entity: it must exist in this session's persisted evidence.
  IF NOT EXISTS (
    SELECT 1 FROM public.central_needs_source_records
     WHERE import_session_id = p_import_session_id AND target_entity = v_entity
  ) THEN
    RAISE EXCEPTION 'target_entity_not_in_import_session' USING ERRCODE = 'P0002',
      DETAIL = format('session=%s target_entity=%s', p_import_session_id, v_entity),
      HINT = 'Only an entity present in this session''s authoritative source evidence can be mapped.';
  END IF;

  SELECT name INTO v_item_label FROM public.central_items WHERE id = p_central_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'central_item_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing
    FROM public.central_needs_record_mappings
   WHERE import_session_id = p_import_session_id AND target_entity = v_entity
   FOR UPDATE;

  IF FOUND AND v_existing.central_item_id = p_central_item_id THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'mapping_id', v_existing.id, 'import_session_id', p_import_session_id,
      'target_entity', v_entity, 'central_item_id', p_central_item_id
    );
  END IF;

  INSERT INTO public.central_needs_record_mappings (
    import_session_id, organization_id, target_entity, central_item_id, mapped_by
  ) VALUES (
    p_import_session_id, v_session.organization_id, v_entity, p_central_item_id, v_actor
  )
  ON CONFLICT (import_session_id, target_entity) DO UPDATE
    SET central_item_id = EXCLUDED.central_item_id,
        mapped_by       = EXCLUDED.mapped_by
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_session.organization_id, v_actor, v_actor_role,
    'central_needs.record_mapping.set', 'central_needs_record_mapping', v_row.id,
    v_item_label,
    jsonb_build_object(
      'import_session_id', p_import_session_id,
      'plan_revision_id', v_session.plan_revision_id,
      'source_file_id', v_session.source_file_id,
      'target_entity', v_entity,
      'central_item_id', p_central_item_id,
      'previous_central_item_id', v_existing.central_item_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'mapping_id', v_row.id, 'import_session_id', p_import_session_id,
    'target_entity', v_entity, 'central_item_id', p_central_item_id,
    'previous_central_item_id', v_existing.central_item_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_set_record_mapping(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_set_record_mapping(uuid, text, uuid) TO authenticated;

-- ============================================================================
-- 10. RPC — reasoned field override.
--
--     Addressed by source_record_id, so a correction always names the exact
--     authoritative evidence it corrects. previous_value is DERIVED from that
--     lineage — the latest prior override of the same record if one exists,
--     otherwise the record's own immutable source value — never supplied by
--     the caller and never silently NULL.
-- ============================================================================
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
  SELECT o.final_value INTO v_previous
    FROM public.central_needs_field_overrides o
   WHERE o.source_record_id = p_source_record_id
   ORDER BY o.created_at DESC
   LIMIT 1;

  -- ...otherwise from the record's own immutable evidence, which is READ here
  -- and never written.
  IF NOT FOUND THEN
    v_previous := v_record.source_values;
  END IF;

  INSERT INTO public.central_needs_field_overrides (
    plan_revision_id, organization_id, source_record_id, target_entity, field_name,
    previous_value, final_value, override_reason, override_note, override_reference, actor_id
  ) VALUES (
    v_session.plan_revision_id, v_record.organization_id, p_source_record_id,
    v_record.target_entity, v_record.field_name,
    v_previous, p_final_value, v_reason,
    NULLIF(btrim(p_override_note), ''), NULLIF(btrim(p_override_reference), ''), v_actor
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

  -- A revision with no authoritatively finalized import has nothing to review.
  -- This is what stops a provisional, browser-only result travelling further.
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

  v_revision   := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);
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
--     central_needs.approve authority.
--
--     A rejected revision is permanent history. Section 6's
--     p_open_next_revision opens a corrected successor beside it.
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
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'rejection_reason_required' USING ERRCODE = '23514';
  END IF;

  v_revision   := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);
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
  IF to_regclass('public.central_needs_record_mappings') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): central_needs_record_mappings is missing';
  END IF;
  IF NOT (
    SELECT relrowsecurity AND relforcerowsecurity
    FROM pg_class WHERE oid = 'public.central_needs_record_mappings'::regclass
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): central_needs_record_mappings does not have RLS enabled+forced';
  END IF;

  FOREACH f IN ARRAY ARRAY[
    'central_needs_import_sessions_authoritative_finalization_chk',
    'central_needs_record_mappings_session_org_fk',
    'central_needs_source_records_session_ordinal_key',
    'central_needs_source_records_id_org_key',
    'central_needs_field_overrides_source_record_org_fk'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = f) THEN
      RAISE EXCEPTION 'VERIFY FAILED (210): expected constraint % is missing', f;
    END IF;
  END LOOP;

  -- M209's unrepresentable uniqueness must be gone.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'central_needs_source_records_import_session_id_target_entit_key'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): M209 source-record uniqueness still present; duplicate headers remain unrepresentable';
  END IF;

  -- Lineage columns must be NOT NULL.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='central_needs_source_records'
      AND column_name='record_ordinal' AND is_nullable='YES'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): record_ordinal must be NOT NULL';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='central_needs_field_overrides'
      AND column_name='source_record_id' AND is_nullable='YES'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): source_record_id must be NOT NULL';
  END IF;

  -- Client-facing RPCs.
  FOREACH f IN ARRAY ARRAY[
    'public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean)',
    'public.phoenix_central_needs_start_import_session(uuid, text, text, text, jsonb, bigint, text)',
    'public.phoenix_central_needs_set_record_mapping(uuid, text, uuid)',
    'public.phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text)',
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

  -- The TRUSTED replay RPC: service_role ONLY.
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

  -- Internal helpers are NOT client-callable.
  FOREACH f IN ARRAY ARRAY[
    'public._phoenix_central_needs_assert_org_live_v1(uuid)',
    'public._phoenix_central_needs_semantic_digest_v1(uuid)',
    'public._phoenix_central_needs_payload_digest_v1(jsonb)',
    'public._phoenix_central_needs_assert_payload_v1(jsonb, text)',
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

  -- Permission surface unchanged.
  IF (SELECT count(*) FROM public.permission_keys WHERE module = 'central_needs') <> 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): the central_needs permission key count changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.permission_keys WHERE key = 'central_needs.send') THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): central_needs.send must never exist';
  END IF;
  IF EXISTS (SELECT 1 FROM public.role_permission_defaults WHERE permission_key LIKE 'central_needs.%') THEN
    RAISE EXCEPTION 'VERIFY FAILED (210): central_needs.* must keep zero default role grants';
  END IF;

  -- No client write grant leaked onto any Central Needs table.
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
--   DROP FUNCTION IF EXISTS public.phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text);
--   DROP FUNCTION IF EXISTS public.phoenix_central_needs_set_record_mapping(uuid, text, uuid);
--   DROP FUNCTION IF EXISTS public.phoenix_central_needs_apply_authoritative_replay(uuid, text, jsonb, jsonb);
--   DROP FUNCTION IF EXISTS public.phoenix_central_needs_start_import_session(uuid, text, text, text, jsonb, bigint, text);
--   DROP FUNCTION IF EXISTS public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean);
--   DROP FUNCTION IF EXISTS public._phoenix_central_needs_assert_payload_v1(jsonb, text);
--   DROP FUNCTION IF EXISTS public._phoenix_central_needs_payload_digest_v1(jsonb);
--   DROP FUNCTION IF EXISTS public._phoenix_central_needs_semantic_digest_v1(uuid);
--   DROP FUNCTION IF EXISTS public._phoenix_central_needs_assert_draft_v1(uuid, text);
--   DROP FUNCTION IF EXISTS public._phoenix_central_needs_load_revision_v1(uuid);
--   DROP FUNCTION IF EXISTS public._phoenix_central_needs_guard_v1(uuid, text);
--   DROP FUNCTION IF EXISTS public._phoenix_central_needs_assert_org_live_v1(uuid);
--   DROP TABLE IF EXISTS public.central_needs_record_mappings;
--   ALTER TABLE public.central_needs_field_overrides
--     DROP CONSTRAINT IF EXISTS central_needs_field_overrides_source_record_org_fk,
--     DROP COLUMN IF EXISTS source_record_id;
--   ALTER TABLE public.central_needs_source_records
--     DROP CONSTRAINT IF EXISTS central_needs_source_records_id_org_key,
--     DROP CONSTRAINT IF EXISTS central_needs_source_records_session_ordinal_key,
--     DROP CONSTRAINT IF EXISTS central_needs_source_records_ordinal_positive_chk,
--     DROP COLUMN IF EXISTS record_ordinal,
--     ADD CONSTRAINT central_needs_source_records_import_session_id_target_entit_key
--       UNIQUE (import_session_id, target_entity, field_name);
--   ALTER TABLE public.central_needs_import_sessions
--     DROP CONSTRAINT IF EXISTS central_needs_import_sessions_authoritative_finalization_chk,
--     DROP CONSTRAINT IF EXISTS central_needs_import_sessions_authoritative_digest_chk,
--     DROP CONSTRAINT IF EXISTS central_needs_import_sessions_preview_digest_chk,
--     DROP COLUMN IF EXISTS parser_identity,
--     DROP COLUMN IF EXISTS authoritative_digest,
--     DROP COLUMN IF EXISTS preview_digest;
--   COMMIT;
-- ============================================================================
