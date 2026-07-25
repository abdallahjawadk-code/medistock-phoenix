-- ============================================================================
-- PAPER-REFERENCE-CONTRACT-110   ***PREPARED - DO NOT APPLY TO PRODUCTION***
--
-- MANUAL APPLY ONLY (SQL Editor), after owner review, AFTER 109. Never via
-- `supabase db push`. Replay 001->110 must be proven on the disposable rig
-- before this is considered ready.
--
-- WHY
-- Audited first (functional-closure Section 1): 090 already gives
-- warehouse_stock_movements a server-generated, sequence-backed, client-
-- unsettable official_number (WR-/WA-YYYY-nnnnnn). warehouse_dispatches
-- already has dispatch_number (server) and an optional document_number
-- (external reference, not unique). warehouse_return_requests /
-- outlet_return_requests carry their own return_number. NONE of these carry
-- a genuine "paper reference" concept — رقم الكتاب (the physical/official
-- paper document number a real-world instruction traces back to), تاريخ
-- الكتاب, or الجهة المصدرة. Grepped the whole src/ and supabase/ tree for
-- paper_reference|issuing_authority|رقم الكتاب before writing this file:
-- zero prior hits. This is a genuine, clean gap — not a rebuild.
--
-- CONTRACT
--   * ONE new table, phoenix_paper_references, additively linked to whichever
--     document a paper reference belongs to via (document_type, document_id)
--     — NOT five sets of duplicate columns bolted onto five different
--     tables. This keeps the contract in one place and avoids the "duplicate
--     column" trap the task brief explicitly warned against.
--   * document_type in ('warehouse_dispatch', 'warehouse_return_request',
--     'outlet_return_request', 'stock_correction_request',
--     'warehouse_stock_movement') — the five tables audited as genuine
--     "documents" a paper reference could attach to. Every other table this
--     task touched (thresholds, status reports, stocktakes, notifications)
--     is not a paper-tracked document and is deliberately excluded.
--   * paper_reference_number / paper_reference_date / issuing_authority /
--     paper_reference_notes — all nullable/optional, exactly as specified.
--   * The canonical UUID (document_id) and each table's own official/server
--     number (official_number / dispatch_number / return_number) are
--     UNCHANGED and remain authoritative; the paper reference is a THIRD,
--     separate, optional field-set, never a replacement.
--   * Editable only while the parent document is still in its pre-decision
--     state (draft for dispatch/return requests, pending for correction
--     requests) — enforced SERVER-SIDE inside phoenix_set_paper_reference,
--     not merely UI-disabled: the RPC re-derives the document's current
--     status/editability on every call and raises if it has moved on.
--     warehouse_stock_movements carries no draft state at all (065/090 post
--     it as a single, already-decided fact) — for that document_type the
--     reference is settable exactly ONCE (immediately immutable after that),
--     mirroring the movement row's own append-only nature rather than
--     inventing a draft period that does not exist for it.
--   * Duplicate detection scoped to (organization_id, issuing_authority,
--     extract(year from paper_reference_date), document_type,
--     normalized_reference) is a WARN, not a hard block: a paper document
--     CAN legitimately be re-referenced (e.g. one paper instruction covering
--     two operations), so phoenix_set_paper_reference always succeeds and
--     returns possible_duplicate + the matching document ids (same
--     organization only) rather than raising. This mirrors 106/107's own
--     stated idiom of returning a signal rather than refusing when an
--     operation might be a legitimate repeat, and No prior hard-uniqueness
--     precedent exists in this codebase for a human-entered paper number
--     (090's official_number uniqueness is over a SERVER-generated value,
--     a materially different case), so this migration documents its warn-
--     not-block choice explicitly rather than inventing a false precedent.
--   * Normalization: lower-cased, trimmed, with whitespace/dash/underscore/
--     slash/dot/comma separators stripped (regexp_replace, ASCII pattern —
--     deliberately NOT a Unicode character-class alnum extraction, which is
--     collation-risky for Arabic text in a plpgsql STORED generated column;
--     stripping known separator punctuation is safe and sufficient for
--     matching "12/2026" against "12-2026" against "12 2026").
--   * Cross-org non-oracle: EVERY read path (RLS SELECT policy, the
--     duplicate-detection query inside the write RPC, and the search RPC)
--     filters by organization_id = the caller's own org (or super_admin) as
--     a WHERE-clause predicate, never as a post-filter — a query that
--     matches nothing in the caller's org returns zero rows, identical to a
--     paper reference that does not exist anywhere, even if the SAME number
--     is attached to a document in a different organization.
--
-- DEFERRED, NOT DONE HERE (reported honestly, not silently dropped):
--   * QR payload / PDF export / XLSX export (receipt-xlsx.ts) wiring of the
--     paper reference is NOT done in this migration (SQL-only pass) — it is
--     a src/ change, tracked as open follow-up work.
--   * A single unified search across UUID + every table's own official
--     number + paper reference (with disambiguation) is NOT built here;
--     phoenix_search_paper_reference below covers ONLY the paper-reference
--     half of that eventual contract.
--
-- PRECONDITIONS: 001..109 applied.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.warehouse_dispatches') IS NULL
     OR to_regclass('public.warehouse_return_requests') IS NULL
     OR to_regclass('public.outlet_return_requests') IS NULL
     OR to_regclass('public.phoenix_stock_correction_requests') IS NULL
     OR to_regclass('public.warehouse_stock_movements') IS NULL THEN
    RAISE EXCEPTION '110 PRECONDITION FAILED: one or more prerequisite document tables missing (need 061/069/071/098/065).';
  END IF;
  IF to_regclass('public.phoenix_paper_references') IS NOT NULL THEN
    RAISE EXCEPTION '110 PRECONDITION FAILED: already applied.';
  END IF;
END
$precond$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. phoenix_paper_references
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.phoenix_paper_references (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  document_type         text NOT NULL CHECK (document_type IN (
                            'warehouse_dispatch', 'warehouse_return_request',
                            'outlet_return_request', 'stock_correction_request',
                            'warehouse_stock_movement'
                          )),
  document_id           uuid NOT NULL,
  paper_reference_number text,
  paper_reference_date   date,
  issuing_authority      text,
  paper_reference_notes  text,
  -- Server-derived, never client-supplied: normalized form used for
  -- duplicate detection and search. NULL when no number was given.
  normalized_reference   text GENERATED ALWAYS AS (
                            CASE WHEN paper_reference_number IS NULL THEN NULL
                            ELSE regexp_replace(lower(btrim(paper_reference_number)), '[\s\-_/\.,]+', '', 'g')
                            END
                          ) STORED,
  created_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phoenix_paper_references_doc_uniq UNIQUE (document_type, document_id),
  CONSTRAINT phoenix_paper_references_number_chk
    CHECK (paper_reference_number IS NULL OR (btrim(paper_reference_number) = paper_reference_number AND paper_reference_number <> '')),
  CONSTRAINT phoenix_paper_references_authority_chk
    CHECK (issuing_authority IS NULL OR (btrim(issuing_authority) = issuing_authority AND issuing_authority <> ''))
);

COMMENT ON TABLE public.phoenix_paper_references IS
  'Optional paper-trail reference (رقم/تاريخ الكتاب، الجهة المصدرة) attached '
  '1:1 to a warehouse_dispatch / warehouse_return_request / '
  'outlet_return_request / stock_correction_request / '
  'warehouse_stock_movement row. Never the authoritative key — the document '
  'UUID and that table''s own server-generated number remain canonical. '
  'Writes only via phoenix_set_paper_reference (110); reads RLS-scoped by '
  'organization_id, matching this codebase''s cross-org isolation posture.';

CREATE INDEX phoenix_paper_references_dup_idx
  ON public.phoenix_paper_references (organization_id, document_type, issuing_authority, normalized_reference);

CREATE INDEX phoenix_paper_references_org_idx
  ON public.phoenix_paper_references (organization_id, document_type);

ALTER TABLE public.phoenix_paper_references ENABLE ROW LEVEL SECURITY;

CREATE POLICY phoenix_paper_references_select_scoped
  ON public.phoenix_paper_references
  FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'super_admin'
    OR organization_id = public.phoenix_my_org()
  );
-- No INSERT/UPDATE/DELETE policy — every write goes through
-- phoenix_set_paper_reference (SECURITY DEFINER) below.

REVOKE ALL ON TABLE public.phoenix_paper_references FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.phoenix_paper_references TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. phoenix_paper_reference_document_context — internal-only helper.
--    Resolves (organization_id, editable) per document_type. NOT granted to
--    authenticated: it would otherwise be a cross-org existence oracle for
--    an arbitrary document_id (returning non-null org for any id that
--    exists anywhere). Only phoenix_set_paper_reference below calls it, as
--    the same owner, inside one SECURITY DEFINER transaction.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_paper_reference_document_context(
  p_document_type text,
  p_document_id   uuid
)
RETURNS TABLE (organization_id uuid, editable boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_document_type = 'warehouse_dispatch' THEN
    RETURN QUERY SELECT d.organization_id, (d.status = 'draft')
      FROM public.warehouse_dispatches d WHERE d.id = p_document_id;
  ELSIF p_document_type = 'warehouse_return_request' THEN
    RETURN QUERY SELECT r.source_organization_id, (r.status = 'draft')
      FROM public.warehouse_return_requests r WHERE r.id = p_document_id;
  ELSIF p_document_type = 'outlet_return_request' THEN
    RETURN QUERY SELECT r.source_organization_id, (r.status = 'draft')
      FROM public.outlet_return_requests r WHERE r.id = p_document_id;
  ELSIF p_document_type = 'stock_correction_request' THEN
    RETURN QUERY SELECT c.organization_id, (c.status = 'pending')
      FROM public.phoenix_stock_correction_requests c WHERE c.id = p_document_id;
  ELSIF p_document_type = 'warehouse_stock_movement' THEN
    RETURN QUERY SELECT m.organization_id,
      NOT EXISTS (
        SELECT 1 FROM public.phoenix_paper_references pr
        WHERE pr.document_type = 'warehouse_stock_movement' AND pr.document_id = p_document_id
      )
      FROM public.warehouse_stock_movements m WHERE m.id = p_document_id;
  ELSE
    RAISE EXCEPTION 'invalid_document_type' USING ERRCODE = '23514';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_paper_reference_document_context(text, uuid) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. phoenix_set_paper_reference — the ONLY writer.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_set_paper_reference(
  p_document_type          text,
  p_document_id            uuid,
  p_paper_reference_number text,
  p_paper_reference_date   date DEFAULT NULL,
  p_issuing_authority      text DEFAULT NULL,
  p_paper_reference_notes  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_role     text;
  v_org      uuid;
  v_editable boolean;
  v_number   text := NULLIF(btrim(p_paper_reference_number), '');
  v_authority text := NULLIF(btrim(coalesce(p_issuing_authority, '')), '');
  v_notes    text := NULLIF(btrim(coalesce(p_paper_reference_notes, '')), '');
  v_norm     text;
  v_id       uuid;
  v_dupes    jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF p_document_type NOT IN (
    'warehouse_dispatch', 'warehouse_return_request', 'outlet_return_request',
    'stock_correction_request', 'warehouse_stock_movement'
  ) THEN
    RAISE EXCEPTION 'invalid_document_type' USING ERRCODE = '23514';
  END IF;
  IF p_document_id IS NULL THEN RAISE EXCEPTION 'document_id_required' USING ERRCODE = '23514'; END IF;

  SELECT ctx.organization_id, ctx.editable INTO v_org, v_editable
  FROM public.phoenix_paper_reference_document_context(p_document_type, p_document_id) ctx;
  IF v_org IS NULL THEN RAISE EXCEPTION 'document_not_found' USING ERRCODE = 'P0002'; END IF;

  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT (
    v_role = 'super_admin'
    OR (public.phoenix_my_org() = v_org
        AND v_role IN ('warehouse_officer', 'institution_admin', 'central_warehouse_manager', 'outlet_officer'))
  ) THEN
    RAISE EXCEPTION 'not_authorized_paper_reference' USING ERRCODE = '42501';
  END IF;

  IF NOT v_editable THEN
    RAISE EXCEPTION 'paper_reference_locked_document_not_editable' USING ERRCODE = '55000';
  END IF;

  IF v_number IS NOT NULL THEN
    v_norm := regexp_replace(lower(v_number), '[\s\-_/\.,]+', '', 'g');
    SELECT jsonb_agg(jsonb_build_object('document_type', pr.document_type, 'document_id', pr.document_id))
      INTO v_dupes
    FROM public.phoenix_paper_references pr
    WHERE pr.organization_id = v_org   -- same-org only: never a cross-org oracle
      AND pr.document_id <> p_document_id
      AND pr.document_type = p_document_type
      AND coalesce(pr.issuing_authority, '') = coalesce(v_authority, '')
      AND extract(year FROM pr.paper_reference_date) IS NOT DISTINCT FROM extract(year FROM p_paper_reference_date)
      AND pr.normalized_reference = v_norm;
  END IF;

  INSERT INTO public.phoenix_paper_references (
    organization_id, document_type, document_id, paper_reference_number,
    paper_reference_date, issuing_authority, paper_reference_notes, created_by, updated_by
  ) VALUES (
    v_org, p_document_type, p_document_id, v_number,
    p_paper_reference_date, v_authority, v_notes, v_actor, v_actor
  )
  ON CONFLICT (document_type, document_id) DO UPDATE SET
    paper_reference_number = EXCLUDED.paper_reference_number,
    paper_reference_date   = EXCLUDED.paper_reference_date,
    issuing_authority      = EXCLUDED.issuing_authority,
    paper_reference_notes  = EXCLUDED.paper_reference_notes,
    updated_by = v_actor, updated_at = now()
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_org, v_actor, v_role, 'update', 'paper_reference', v_id, p_document_type,
    jsonb_build_object(
      'document_id', p_document_id, 'paper_reference_number', v_number,
      'issuing_authority', v_authority, 'possible_duplicate', (v_dupes IS NOT NULL)
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'id', v_id,
    'possible_duplicate', (v_dupes IS NOT NULL),
    'duplicate_matches', coalesce(v_dupes, '[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_set_paper_reference(text, uuid, text, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_set_paper_reference(text, uuid, text, date, text, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_set_paper_reference(text, uuid, text, date, text, text) IS
  'The ONLY writer of phoenix_paper_references. Enforces: org match, role '
  'allow-list, document-editable gate (server-derived per document_type, '
  're-checked on every call so a document that has moved past draft/pending '
  'cannot be edited even if the client UI is stale), and duplicate-warn '
  '(never hard-block) scoped strictly to the caller''s own organization.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. phoenix_search_paper_reference — cross-org non-oracle lookup by number.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_search_paper_reference(p_query text)
RETURNS TABLE (
  document_type    text,
  document_id      uuid,
  paper_reference_number text,
  paper_reference_date   date,
  issuing_authority      text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_norm  text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF p_query IS NULL OR btrim(p_query) = '' THEN RETURN; END IF;
  v_org := public.phoenix_my_org();
  v_norm := regexp_replace(lower(btrim(p_query)), '[\s\-_/\.,]+', '', 'g');

  RETURN QUERY
  SELECT pr.document_type, pr.document_id, pr.paper_reference_number, pr.paper_reference_date, pr.issuing_authority
  FROM public.phoenix_paper_references pr
  WHERE (public.phoenix_my_role() = 'super_admin' OR pr.organization_id = v_org)
    AND pr.normalized_reference = v_norm
  ORDER BY pr.created_at DESC
  LIMIT 20;
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_search_paper_reference(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_search_paper_reference(text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_search_paper_reference(text) IS
  'Looks up a paper reference by (normalized) number, scoped strictly to '
  'the caller''s own organization (or all orgs for super_admin). A number '
  'that only exists in a DIFFERENT organization returns zero rows — '
  'identical to a number that does not exist anywhere — never a cross-org '
  'existence oracle.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Verify
-- ─────────────────────────────────────────────────────────────────────────────
DO $verify$
BEGIN
  ASSERT to_regclass('public.phoenix_paper_references') IS NOT NULL, 'VERIFY FAILED (110): table missing';
  ASSERT to_regprocedure('public.phoenix_set_paper_reference(text, uuid, text, date, text, text)') IS NOT NULL,
    'VERIFY FAILED (110): phoenix_set_paper_reference missing';
  ASSERT to_regprocedure('public.phoenix_search_paper_reference(text)') IS NOT NULL,
    'VERIFY FAILED (110): phoenix_search_paper_reference missing';
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE table_name = 'phoenix_paper_references' AND grantee = 'authenticated'
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  ), 'VERIFY FAILED (110): authenticated must not hold direct write privileges on phoenix_paper_references';
  RAISE NOTICE 'PAPER-REFERENCE-CONTRACT-110: verified.';
END
$verify$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS (read-only, after apply):
--   SELECT count(*) FROM information_schema.table_privileges
--    WHERE table_name='phoenix_paper_references' AND grantee='authenticated'
--      AND privilege_type IN ('INSERT','UPDATE','DELETE');  -- 0
--   SELECT has_table_privilege('authenticated', 'public.phoenix_paper_references', 'SELECT'); -- true (RLS still scopes rows)
-- ROLLBACK (lossless; no prior data existed for this table):
--   DROP FUNCTION public.phoenix_search_paper_reference(text);
--   DROP FUNCTION public.phoenix_set_paper_reference(text, uuid, text, date, text, text);
--   DROP FUNCTION public.phoenix_paper_reference_document_context(text, uuid);
--   DROP TABLE public.phoenix_paper_references;
-- ============================================================================
