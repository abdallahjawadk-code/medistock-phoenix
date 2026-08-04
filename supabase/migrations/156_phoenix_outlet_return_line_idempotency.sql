-- ============================================================================
-- OUTLET-RETURN-LINE-IDEMPOTENCY-156
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 155.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase D0's audit flagged that Route 3's ADD-LINE step (adding a line to an
-- outlet_return_requests draft) has no full server-side idempotency: retry
-- safety today is entirely client-side (the composer reloads canonical lines
-- and diffs before allowing a resend). Unlike 071's pre-106
-- warehouse_dispatch_lines gap, outlet_return_request_lines already has a
-- UNIQUE index (orrl_request_dispatch_line_uniq, 071) on
-- (return_request_id, original_dispatch_line_id) that blocks a true exact
-- duplicate INSERT -- but only by raising a raw, untranslated 23505 straight
-- out of the INSERT statement. A lost-response retry gets that same bare
-- unique_violation, indistinguishable from a genuine conflict, after
-- re-running the entire permission/provenance/cap/availability validation
-- chain for nothing. There is no clean idempotent replay (returning the
-- original line id) and no dedup of the accompanying audit_logs row.
--
-- UPGRADE CONTRACT: the exact same shape as DISPATCH-LINE-IDEMPOTENCY-106-A,
-- applied to phoenix_add_outlet_return_request_line instead of
-- phoenix_add_dispatch_line_fefo_guarded. Optional (backward-compatible)
-- p_request_id, a dedicated dedup ledger, sha256 payload fingerprint,
-- advisory-lock-then-check-then-insert, replay-on-match /
-- conflict-on-mismatch. 106's own header comment documents why the
-- OLD-signature-DROP-then-CREATE approach (rather than a naive CREATE OR
-- REPLACE with one new trailing DEFAULT-ed parameter) is required to avoid a
-- second, ambiguous overload -- the same empirically-verified reasoning
-- applies here unchanged. Confirmed no other overload of this function
-- exists before writing this file:
--   $ grep -n "phoenix_add_outlet_return_request_line" supabase/migrations/*.sql
--   -> defined in 071, redefined in 095, redefined again in 148 (adds the
--      leading advisory lock on the dispatch-line key) -- 148's is the
--      current, single, authoritative (uuid,uuid,integer,text,text)
--      signature; no other overload exists.
--
-- DEDUP TABLE: phoenix_outlet_return_line_requests, same shape as 106's
-- phoenix_dispatch_line_requests (one row per client-supplied request_id,
-- fingerprint + stored result), reused verbatim rather than inventing a
-- second idempotency idiom for this corridor.
--
-- BEHAVIOR when p_request_id IS NOT NULL:
--   1. Compute the fingerprint, then take a per-request advisory xact lock
--      (salt 156156, distinct from 106's 106106 so the two corridors' locks
--      never collide even if a request_id were somehow reused across them)
--      BEFORE reading/writing the dedup row, so two truly concurrent
--      connections submitting the SAME request_id serialize.
--   2. Same request_id + SAME fingerprint already present -> return the
--      stored `result` unchanged. No new line, no new audit row.
--   3. Same request_id + DIFFERENT fingerprint already present -> raise
--      ERRCODE 23505 (request_id_conflict). The client must treat this as
--      "not a safe retry", never silently retry it again.
--   4. Otherwise: run the EXISTING permission/provenance/cap/availability/
--      insert/audit logic completely unchanged, then INSERT the dedup row
--      before returning, all inside the same transaction as the mutation.
-- BEHAVIOR when p_request_id IS NULL (the default): completely unchanged --
-- no dedup table read or write at all. 148's orrl_request_dispatch_line_uniq
-- still stands as the underlying structural guarantee either way.
--
-- Nothing about RLS, permission checks, provenance/cap/availability
-- validation, or audit logging is touched -- this migration only wraps that
-- unchanged logic with the dedup layer described above.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure(
    'public.phoenix_add_outlet_return_request_line(uuid,uuid,integer,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 148 phoenix_add_outlet_return_request_line is missing';
  END IF;
  IF to_regprocedure('public._phoenix_lock_inventory_resources(text[])') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 148 _phoenix_lock_inventory_resources is missing';
  END IF;
END;
$precond$;

-- ── A. Dedup table — one row per client-supplied request id ────────────────

CREATE TABLE public.phoenix_outlet_return_line_requests (
  request_id             uuid PRIMARY KEY,
  organization_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  return_request_id      uuid NOT NULL,
  payload_fingerprint    text NOT NULL,
  result                 jsonb NOT NULL,
  return_request_line_id uuid,
  actor_id                uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.phoenix_outlet_return_line_requests IS
  'Server-side idempotency ledger for phoenix_add_outlet_return_request_line '
  '(156, wrapping 148). One row per client-supplied p_request_id. A replay '
  'with the SAME payload_fingerprint returns the stored result unchanged; a '
  'replay with a DIFFERENT fingerprint under the same request_id is a '
  '23505 conflict, never a silent second mutation. Only written by the RPC '
  'itself (SECURITY DEFINER) inside the same transaction as the mutation it '
  'guards, so mutation and dedup-record are atomically all-or-nothing.';

CREATE INDEX phoenix_outlet_return_line_requests_org_idx
  ON public.phoenix_outlet_return_line_requests (organization_id, created_at);

ALTER TABLE public.phoenix_outlet_return_line_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY phoenix_outlet_return_line_requests_select_scoped
  ON public.phoenix_outlet_return_line_requests
  FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'super_admin'
    OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
  );

REVOKE INSERT, UPDATE, DELETE ON TABLE public.phoenix_outlet_return_line_requests FROM authenticated;
GRANT SELECT ON TABLE public.phoenix_outlet_return_line_requests TO authenticated;

-- ── B. Guarded add-line, now with an optional server-side idempotency key ──
--
-- DROP the exact old 5-parameter signature BEFORE recreating under the same
-- name with 6 parameters — see the header comment above (and 106's own,
-- empirically-verified reasoning) for why this is required to avoid a
-- second, ambiguous overload.
DROP FUNCTION IF EXISTS public.phoenix_add_outlet_return_request_line(uuid, uuid, integer, text, text);

CREATE OR REPLACE FUNCTION public.phoenix_add_outlet_return_request_line(
  p_return_request_id            uuid,
  p_original_dispatch_line_id    uuid DEFAULT NULL,
  p_requested_quantity           integer DEFAULT NULL,
  p_reason_code                  text DEFAULT NULL,
  p_reason_text                  text DEFAULT NULL,
  p_request_id                   uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_request      public.outlet_return_requests%ROWTYPE;
  v_dispatch     public.warehouse_dispatch_lines%ROWTYPE;
  v_movement     public.outlet_stock_movements%ROWTYPE;
  v_stock        public.outlet_stock%ROWTYPE;
  v_reason_text  text := NULLIF(btrim(p_reason_text), '');
  v_line         public.outlet_return_request_lines%ROWTYPE;
  v_cap          integer;
  v_available    integer;
  v_result       jsonb;
  v_fp           text;
  v_existing     public.phoenix_outlet_return_line_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL THEN
    RAISE EXCEPTION 'return_request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_original_dispatch_line_id IS NULL THEN
    RAISE EXCEPTION 'original_dispatch_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_requested_quantity IS NULL OR p_requested_quantity <= 0 THEN
    RAISE EXCEPTION 'requested_quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF p_reason_code IS NULL OR p_reason_code NOT IN (
    'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',
    'recalled', 'quality_issue', 'temperature_excursion', 'other'
  ) THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '23514';
  END IF;

  -- ── Idempotency gate — only when the caller opts in with a request id ────
  IF p_request_id IS NOT NULL THEN
    v_fp := encode(sha256(convert_to(jsonb_build_object(
      'operation', 'add_outlet_return_request_line',
      'return_request_id', p_return_request_id,
      'original_dispatch_line_id', p_original_dispatch_line_id,
      'requested_quantity', p_requested_quantity,
      'reason_code', p_reason_code,
      'reason_text', v_reason_text,
      'actor', v_actor
    )::text, 'UTF8')), 'hex');

    -- Serializes two truly concurrent connections submitting the SAME
    -- request_id: the second blocks here until the first's transaction
    -- (commit or rollback) releases the lock, then observes a committed
    -- dedup row (or, on the first's rollback, none — and proceeds fresh).
    -- Salt 156156 is distinct from 106's 106106 so the two corridors' locks
    -- never collide even if a request_id were somehow reused across them.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 156156));

    SELECT * INTO v_existing
    FROM public.phoenix_outlet_return_line_requests
    WHERE request_id = p_request_id;

    IF FOUND THEN
      IF v_existing.payload_fingerprint IS DISTINCT FROM v_fp THEN
        RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505',
          DETAIL = 'same request_id previously submitted with a different payload — refresh and resubmit as a new request';
      END IF;
      -- Exact replay: return the ORIGINAL result, no second mutation.
      RETURN v_existing.result;
    END IF;
  END IF;

  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_provline:' || p_original_dispatch_line_id::text
  ]);

  SELECT * INTO v_request
  FROM public.outlet_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'return_request_not_editable' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.return_request', v_request.source_organization_id,
    NULL, v_request.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_return_request' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatch_lines WHERE id = p_original_dispatch_line_id FOR UPDATE;
  IF NOT FOUND OR v_dispatch.organization_id <> v_request.source_organization_id THEN
    RAISE EXCEPTION 'original_dispatch_line_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_dispatch.status NOT IN ('accepted', 'accepted_with_difference')
     OR v_dispatch.resulting_outlet_stock_id IS NULL THEN
    RAISE EXCEPTION 'original_dispatch_line_not_a_completed_receipt' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_stock
  FROM public.outlet_stock WHERE id = v_dispatch.resulting_outlet_stock_id FOR UPDATE;
  IF NOT FOUND OR v_stock.distribution_point_id <> v_request.distribution_point_id THEN
    RAISE EXCEPTION 'original_dispatch_line_not_at_this_outlet' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_movement
  FROM public.outlet_stock_movements
  WHERE dispatch_line_id = v_dispatch.id
    AND movement_type = 'dispatch_receive'
    AND outlet_stock_id = v_stock.id
    AND organization_id = v_request.source_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_receive_movement_not_found_for_line' USING ERRCODE = 'P0002';
  END IF;

  IF v_dispatch.scientific_name IS DISTINCT FROM v_stock.scientific_name
     OR COALESCE(v_dispatch.concentration,'') IS DISTINCT FROM COALESCE(v_stock.concentration,'')
     OR COALESCE(v_dispatch.dosage_form,'')   IS DISTINCT FROM COALESCE(v_stock.dosage_form,'')
     OR COALESCE(v_dispatch.national_code,'') IS DISTINCT FROM COALESCE(v_stock.national_code,'')
     OR COALESCE(v_dispatch.batch_number,'')  IS DISTINCT FROM COALESCE(v_stock.batch_number,'')
     OR COALESCE(v_dispatch.internal_batch_reference,'') IS DISTINCT FROM COALESCE(v_stock.internal_batch_reference,'')
     OR v_dispatch.expiry_date IS DISTINCT FROM v_stock.expiry_date THEN
    RAISE EXCEPTION 'provenance_material_batch_expiry_mismatch' USING ERRCODE = '23514';
  END IF;

  v_cap := COALESCE(v_dispatch.received_quantity, 0) - v_dispatch.returned_quantity;
  IF p_requested_quantity > v_cap THEN
    RAISE EXCEPTION 'requested_quantity_exceeds_returnable_cap' USING ERRCODE = '23514';
  END IF;

  v_available := COALESCE(v_stock.on_hand_quantity, 0) - COALESCE(v_stock.reserved_quantity, 0);
  IF p_requested_quantity > v_available THEN
    RAISE EXCEPTION 'requested_quantity_exceeds_current_availability' USING ERRCODE = '23514',
      DETAIL = format('requested %s, currently available %s (on_hand - reserved)',
                       p_requested_quantity, v_available);
  END IF;

  INSERT INTO public.outlet_return_request_lines (
    return_request_id, source_organization_id,
    original_dispatch_line_id, original_inbound_movement_id,
    original_inbound_movement_type, source_outlet_stock_id,
    scientific_name, concentration, dosage_form, unit, national_code,
    batch_number, internal_batch_reference, expiry_date,
    reason_code, reason_text, requested_quantity
  ) VALUES (
    p_return_request_id, v_request.source_organization_id,
    v_dispatch.id, v_movement.id,
    'dispatch_receive', v_stock.id,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date,
    p_reason_code, v_reason_text, p_requested_quantity
  )
  RETURNING * INTO v_line;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.source_organization_id, v_actor, v_actor_role,
    'outlet_stock.return_line_added', 'outlet_return_request_lines', v_line.id, v_line.scientific_name,
    jsonb_build_object(
      'return_request_id', p_return_request_id,
      'original_dispatch_line_id', v_dispatch.id,
      'original_inbound_movement_id', v_movement.id,
      'source_outlet_stock_id', v_stock.id,
      'reason_code', p_reason_code,
      'requested_quantity', p_requested_quantity
    )
  );

  v_result := jsonb_build_object('ok', true, 'return_request_line_id', v_line.id);

  -- ── Record the dedup row in the SAME transaction as the mutation above ──
  IF p_request_id IS NOT NULL THEN
    INSERT INTO public.phoenix_outlet_return_line_requests (
      request_id, organization_id, return_request_id, payload_fingerprint, result, return_request_line_id, actor_id
    ) VALUES (
      p_request_id, v_request.source_organization_id, p_return_request_id, v_fp, v_result, v_line.id, v_actor
    );
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_add_outlet_return_request_line(uuid, uuid, integer, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_add_outlet_return_request_line(uuid, uuid, integer, text, text, uuid) TO authenticated;

COMMENT ON FUNCTION public.phoenix_add_outlet_return_request_line(uuid, uuid, integer, text, text, uuid) IS
  'Adds one provenance-anchored outlet-return line (148), now with an '
  'OPTIONAL server-side idempotency key (156): pass p_request_id to make '
  'retries of the SAME logical add-line attempt (same return request/'
  'dispatch line/quantity/reason/actor) a clean replay instead of a raw '
  '23505 off the underlying orrl_request_dispatch_line_uniq index. Omitting '
  'p_request_id (or NULL, the default) is fully backward compatible with '
  'every existing caller and behaves exactly as before 156. All prior '
  'permission/provenance/cap/availability/audit behavior is unchanged.';

-- =============================================================================
-- VERIFY — inside the transaction; failure rolls back all of 156
-- =============================================================================

DO $$
DECLARE
  v_fn_src   text;
  v_overload_count int;
BEGIN
  -- 1. Dedup table exists, RLS enabled, correctly scoped/granted.
  ASSERT to_regclass('public.phoenix_outlet_return_line_requests') IS NOT NULL,
    'phoenix_outlet_return_line_requests was not created';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.phoenix_outlet_return_line_requests'::regclass),
    'RLS must be enabled on phoenix_outlet_return_line_requests';
  ASSERT has_table_privilege('authenticated', 'public.phoenix_outlet_return_line_requests', 'SELECT'),
    'authenticated must have SELECT on phoenix_outlet_return_line_requests';
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outlet_return_line_requests', 'INSERT'),
    'authenticated must not have direct INSERT on phoenix_outlet_return_line_requests';
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outlet_return_line_requests', 'UPDATE'),
    'authenticated must not have direct UPDATE on phoenix_outlet_return_line_requests';
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outlet_return_line_requests', 'DELETE'),
    'authenticated must not have direct DELETE on phoenix_outlet_return_line_requests';

  -- 2. Exactly ONE overload of phoenix_add_outlet_return_request_line exists
  --    (the old 5-arg OID is gone, replaced by the new 6-arg one) — no
  --    ambiguous overload, matching 106's own empirically-verified contract.
  SELECT count(*) INTO v_overload_count
  FROM pg_proc WHERE proname = 'phoenix_add_outlet_return_request_line';
  ASSERT v_overload_count = 1,
    format('expected exactly 1 phoenix_add_outlet_return_request_line overload, found %s', v_overload_count);
  ASSERT to_regprocedure(
    'public.phoenix_add_outlet_return_request_line(uuid,uuid,integer,text,text,uuid)'
  ) IS NOT NULL, 'the new 6-arg signature must exist';
  ASSERT to_regprocedure(
    'public.phoenix_add_outlet_return_request_line(uuid,uuid,integer,text,text)'
  ) IS NULL, 'the old 5-arg signature must no longer exist as a separate overload';

  -- 3. Function still SECURITY DEFINER with pinned search_path, and the new
  --    idempotency machinery is present in its body.
  SELECT pg_get_functiondef(oid) INTO v_fn_src
    FROM pg_proc WHERE proname = 'phoenix_add_outlet_return_request_line';
  ASSERT (
    SELECT prosecdef FROM pg_proc WHERE proname = 'phoenix_add_outlet_return_request_line'
  ), 'phoenix_add_outlet_return_request_line must remain SECURITY DEFINER';
  ASSERT v_fn_src LIKE '%search_path%public%pg_temp%',
    'phoenix_add_outlet_return_request_line must keep search_path pinned to public, pg_temp';
  ASSERT v_fn_src LIKE '%request_id_conflict%',
    'phoenix_add_outlet_return_request_line must raise request_id_conflict on a fingerprint mismatch';
  ASSERT v_fn_src LIKE '%156156%',
    'phoenix_add_outlet_return_request_line must use the 156156 advisory-lock salt';

  -- 4. Grants: EXECUTE for authenticated only, never anon/PUBLIC.
  ASSERT has_function_privilege('authenticated', 'public.phoenix_add_outlet_return_request_line(uuid,uuid,integer,text,text,uuid)', 'EXECUTE'),
    'authenticated must be EXECUTE-granted on the new signature';
  ASSERT NOT has_function_privilege('anon', 'public.phoenix_add_outlet_return_request_line(uuid,uuid,integer,text,text,uuid)', 'EXECUTE'),
    'anon must never be EXECUTE-granted';

  -- 5. 148's underlying structural guarantee (the unique index) is untouched.
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'outlet_return_request_lines'
      AND indexname = 'orrl_request_dispatch_line_uniq'
  ), 'orrl_request_dispatch_line_uniq must survive this migration unchanged';
END $$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. public.phoenix_outlet_return_line_requests exists, RLS enabled,
--    org-scoped SELECT only for authenticated (INSERT/UPDATE/DELETE revoked
--    — only the SECURITY DEFINER RPC writes to it). Re-verified in-transaction
--    above.
-- 2. phoenix_add_outlet_return_request_line resolves to exactly ONE pg_proc
--    row after this migration (the old 5-arg OID is gone, replaced by the
--    new 6-arg one) — no ambiguous overload exists. Re-verified in-transaction
--    above.
-- 3. p_request_id IS NULL (the default) reproduces 148's exact behavior,
--    byte-for-byte, with zero reads/writes against the new dedup table.
-- 4. All prior permission/provenance/cap/availability/audit logic is
--    completely untouched — same source text as before this migration, only
--    reachable through one additional optional parameter.
-- 5. RECONCILIATION: this migration writes no application data itself
--    (function redefinition + one additive table) — nothing to reconcile.
-- ============================================================================
-- ROLLBACK:
--   DROP FUNCTION public.phoenix_add_outlet_return_request_line(
--     uuid, uuid, integer, text, text, uuid);
--   -- then recreate 148's original 5-arg definition from that file, and:
--   DROP TABLE public.phoenix_outlet_return_line_requests;
-- ============================================================================
