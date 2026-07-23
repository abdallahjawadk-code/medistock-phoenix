-- ============================================================================
-- DISPATCH-LINE-IDEMPOTENCY-106-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 105.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- 097's phoenix_add_dispatch_line_fefo_guarded (and the 070 RPC it delegates
-- to) has NO server-side idempotency: retry-safety today is entirely
-- client-side (the composer matches reloaded lines by scientific-name +
-- batch + expiry after a lost response). A lost response on retry has no
-- server-side guarantee against creating two dispatch lines / two
-- warehouse_stock_movements for the same logical add-line attempt.
--
-- UPGRADE CONTRACT CHOSEN, AND A CORRECTION TO THE INITIAL PLAN:
-- The original plan here was "CREATE OR REPLACE the SAME function with one
-- new trailing DEFAULT-ed parameter" on the theory that this preserves a
-- single OID. That theory was checked EMPIRICALLY against a live disposable
-- Postgres before committing to it, and is WRONG: CREATE OR REPLACE FUNCTION
-- only replaces a function whose parameter list (name/type list) is
-- IDENTICAL; changing the parameter list (even by only appending one
-- DEFAULT-ed parameter) makes Postgres create a SECOND, DISTINCT overload
-- alongside the original, e.g.:
--   -- after running 097 then a naive CREATE OR REPLACE with 6 params:
--   SELECT proname, pg_get_function_identity_arguments(oid) FROM pg_proc
--     WHERE proname = 'phoenix_add_dispatch_line_fefo_guarded';
--   ->  (uuid,uuid,integer,boolean,text)              -- the OLD 097 function, still there
--       (uuid,uuid,integer,boolean,text,uuid)         -- a NEW, separate function
-- Two overloads sharing every parameter name of the shorter one is exactly
-- the ambiguous-overload trap this task's own instructions warned against:
-- a PostgREST/supabase-js RPC call using named JSON arguments that omits
-- p_request_id would match BOTH candidates (the 5-arg exactly, the 6-arg via
-- its default) and Postgres would raise 42725 function-not-unique.
--
-- SAFE CONTRACT ACTUALLY USED: explicitly DROP the old 5-parameter function
-- FIRST, then CREATE the new 6-parameter function under the same name. This
-- leaves exactly ONE function with this name in pg_proc afterwards — no
-- overload, no ambiguity — and is still fully backward compatible for every
-- existing caller: a 3-, 4- or 5-positional-argument call still resolves
-- (the trailing p_request_id defaults to NULL, reproducing 097's exact
-- behavior), and a named-argument call omitting p_request_id resolves
-- unambiguously because there is nothing else it could match.
-- Confirmed no OTHER overload of this function exists before writing this
-- file (only 097 ever defined it):
--   $ grep -n "phoenix_add_dispatch_line_fefo_guarded" supabase/migrations/*.sql
--   -> only 097 defines it, single signature (uuid,uuid,integer,boolean,text).
--
-- DEDUP TABLE: phoenix_dispatch_line_requests, one row per p_request_id,
-- storing a payload_fingerprint (sha256 over every input that affects the
-- mutation's outcome, INCLUDING the actor) and the exact jsonb `result` the
-- RPC returned the first time — same fingerprint-and-replay shape 099's
-- phoenix_release_quarantine_stock already established one migration ago,
-- reused verbatim rather than inventing a second idempotency idiom.
--
-- BEHAVIOR when p_request_id IS NOT NULL:
--   1. Compute the fingerprint, then take a per-request advisory xact lock
--      BEFORE reading/writing the dedup row, so two truly concurrent
--      connections submitting the SAME request_id serialize: the second
--      blocks until the first commits (or rolls back) and then observes the
--      first's committed row.
--   2. Same request_id + SAME fingerprint already present -> return the
--      stored `result` unchanged. No new dispatch line, no new movement.
--   3. Same request_id + DIFFERENT fingerprint already present -> raise
--      ERRCODE 23505 (request_id_conflict). The client must treat this as
--      "this is not a safe retry — refresh and resubmit", never silently
--      retry it again.
--   4. Otherwise: run the EXISTING FEFO-guard + insert-line + movement logic
--      completely unchanged, then INSERT the dedup row (fingerprint+result)
--      before returning, all inside the same transaction as the mutation —
--      so a crash between the mutation and the dedup insert cannot happen
--      (single commit, all or nothing).
-- BEHAVIOR when p_request_id IS NULL (the default): completely unchanged —
-- no dedup table read or write at all. Every existing caller that does not
-- yet pass a request id keeps today's exact behavior.
--
-- Nothing about RLS, permission checks, the FEFO fail-closed default, the
-- mandatory non-blank override reason, or audit logging is touched — this
-- migration only wraps that unchanged logic with the dedup layer described
-- above.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure(
    'public.phoenix_add_dispatch_line_fefo_guarded(uuid,uuid,integer,boolean,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 097 phoenix_add_dispatch_line_fefo_guarded is missing';
  END IF;
  IF to_regprocedure(
    'public.phoenix_inventory_fefo_batches(uuid,text,uuid,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 072 phoenix_inventory_fefo_batches is missing';
  END IF;
  IF to_regprocedure('public.phoenix_add_dispatch_line(uuid,uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 070 phoenix_add_dispatch_line is missing';
  END IF;
END;
$precond$;

-- ── A. Dedup table — one row per client-supplied request id ────────────────

CREATE TABLE public.phoenix_dispatch_line_requests (
  request_id           uuid PRIMARY KEY,
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  dispatch_id          uuid NOT NULL,
  payload_fingerprint  text NOT NULL,
  result               jsonb NOT NULL,
  dispatch_line_id     uuid,
  actor_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.phoenix_dispatch_line_requests IS
  'Server-side idempotency ledger for phoenix_add_dispatch_line_fefo_guarded '
  '(106, wrapping 097). One row per client-supplied p_request_id. A replay '
  'with the SAME payload_fingerprint returns the stored result unchanged; a '
  'replay with a DIFFERENT fingerprint under the same request_id is a '
  '23505 conflict, never a silent second mutation. Only written by the RPC '
  'itself (SECURITY DEFINER) inside the same transaction as the mutation it '
  'guards, so mutation and dedup-record are atomically all-or-nothing.';

CREATE INDEX phoenix_dispatch_line_requests_org_idx
  ON public.phoenix_dispatch_line_requests (organization_id, created_at);

ALTER TABLE public.phoenix_dispatch_line_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY phoenix_dispatch_line_requests_select_scoped
  ON public.phoenix_dispatch_line_requests
  FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'super_admin'
    OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
  );

REVOKE INSERT, UPDATE, DELETE ON TABLE public.phoenix_dispatch_line_requests FROM authenticated;
GRANT SELECT ON TABLE public.phoenix_dispatch_line_requests TO authenticated;

-- ── B. Guarded add-line, now with an optional server-side idempotency key ──
--
-- DROP the exact old 5-parameter signature BEFORE recreating under the same
-- name with 6 parameters — see the header comment above for why this is
-- required to avoid a second, ambiguous overload. This is safe: the
-- function's entire behavior (RBAC, FEFO gate, audit) is fully reproduced
-- below, and every caller passing 3-5 positional args, or named args that
-- omit p_request_id, resolves to this ONE function exactly as before.
DROP FUNCTION IF EXISTS public.phoenix_add_dispatch_line_fefo_guarded(uuid, uuid, integer, boolean, text);

CREATE OR REPLACE FUNCTION public.phoenix_add_dispatch_line_fefo_guarded(
  p_dispatch_id        uuid,
  p_warehouse_stock_id uuid,
  p_quantity           integer,
  p_fefo_override      boolean DEFAULT false,
  p_override_reason    text    DEFAULT NULL,
  p_request_id         uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fefo$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dispatch     public.warehouse_dispatches%ROWTYPE;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_fefo_stock   uuid;
  v_fefo_batch   text;
  v_fefo_expiry  date;
  v_reason       text := NULLIF(btrim(p_override_reason), '');
  v_result       jsonb;
  v_fp           text;
  v_existing     public.phoenix_dispatch_line_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_dispatch_id IS NULL OR p_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_id_and_stock_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_dispatch FROM public.warehouse_dispatches WHERE id = p_dispatch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_stock FROM public.warehouse_stock WHERE id = p_warehouse_stock_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- ── Idempotency gate — only when the caller opts in with a request id ────
  IF p_request_id IS NOT NULL THEN
    v_fp := encode(sha256(convert_to(jsonb_build_object(
      'operation', 'add_dispatch_line_fefo_guarded',
      'dispatch_id', p_dispatch_id,
      'warehouse_stock_id', p_warehouse_stock_id,
      'quantity', p_quantity,
      'fefo_override', COALESCE(p_fefo_override, false),
      'override_reason', v_reason,
      'actor', v_actor
    )::text, 'UTF8')), 'hex');

    -- Serializes two truly concurrent connections submitting the SAME
    -- request_id: the second blocks here until the first's transaction
    -- (commit or rollback) releases the lock, then observes a committed
    -- dedup row (or, on the first's rollback, none — and proceeds fresh).
    PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 106106));

    SELECT * INTO v_existing
    FROM public.phoenix_dispatch_line_requests
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

  -- ── FEFO-earliest lot for the SAME material at the SAME warehouse ────────
  SELECT b.stock_id, b.batch_number, b.expiry_date
    INTO v_fefo_stock, v_fefo_batch, v_fefo_expiry
    FROM public.phoenix_inventory_fefo_batches(
           v_dispatch.organization_id, 'warehouse', v_dispatch.warehouse_id,
           v_stock.scientific_name, v_stock.national_code) b
   ORDER BY b.expiry_date ASC NULLS LAST, b.stock_id ASC
   LIMIT 1;

  IF v_fefo_stock IS NOT NULL AND v_fefo_stock IS DISTINCT FROM p_warehouse_stock_id THEN
    -- NOT the FEFO-earliest lot. Fail closed unless override is explicit,
    -- permitted, and reasoned. (Unchanged from 097.)
    IF NOT p_fefo_override THEN
      RAISE EXCEPTION 'fefo_override_required' USING ERRCODE = '23514',
        DETAIL = format('fefo_batch=%s chosen_stock_id=%s', v_fefo_batch, p_warehouse_stock_id);
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'fefo_override_reason_required' USING ERRCODE = '23514';
    END IF;
    IF NOT public.phoenix_profile_has_scoped_permission(
      v_actor, 'inventory.fefo_override', v_dispatch.organization_id, v_dispatch.warehouse_id, NULL
    ) THEN
      RAISE EXCEPTION 'forbidden_fefo_override' USING ERRCODE = '42501';
    END IF;

    SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

    v_result := public.phoenix_add_dispatch_line(p_dispatch_id, p_warehouse_stock_id, p_quantity);

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_dispatch.organization_id, v_actor, v_actor_role,
      'inventory.fefo_overridden', 'warehouse_dispatch_lines',
      NULLIF(v_result ->> 'dispatch_line_id', '')::uuid, v_stock.scientific_name,
      jsonb_build_object(
        'dispatch_id', p_dispatch_id,
        'before_fefo_stock_id', v_fefo_stock, 'before_fefo_batch', v_fefo_batch, 'before_fefo_expiry', v_fefo_expiry,
        'after_chosen_stock_id', p_warehouse_stock_id, 'after_chosen_batch', v_stock.batch_number, 'after_chosen_expiry', v_stock.expiry_date,
        'reason', v_reason, 'quantity', p_quantity
      )
    );

    v_result := v_result || jsonb_build_object('fefo_override_applied', true);
  ELSE
    -- FEFO-compliant (or no other batch exists to compare against) — plain
    -- delegation, no override machinery, no audit noise. (Unchanged from 097.)
    v_result := public.phoenix_add_dispatch_line(p_dispatch_id, p_warehouse_stock_id, p_quantity)
                 || jsonb_build_object('fefo_override_applied', false);
  END IF;

  -- ── Record the dedup row in the SAME transaction as the mutation above ──
  IF p_request_id IS NOT NULL THEN
    INSERT INTO public.phoenix_dispatch_line_requests (
      request_id, organization_id, dispatch_id, payload_fingerprint, result, dispatch_line_id, actor_id
    ) VALUES (
      p_request_id, v_dispatch.organization_id, p_dispatch_id, v_fp, v_result,
      NULLIF(v_result ->> 'dispatch_line_id', '')::uuid, v_actor
    );
  END IF;

  RETURN v_result;
END;
$fefo$;

REVOKE ALL ON FUNCTION public.phoenix_add_dispatch_line_fefo_guarded(uuid, uuid, integer, boolean, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_add_dispatch_line_fefo_guarded(uuid, uuid, integer, boolean, text, uuid) TO authenticated;

COMMENT ON FUNCTION public.phoenix_add_dispatch_line_fefo_guarded(uuid, uuid, integer, boolean, text, uuid) IS
  'FEFO-enforced wrapper over 070''s phoenix_add_dispatch_line (097), now '
  'with an OPTIONAL server-side idempotency key (106): pass p_request_id to '
  'make retries of the SAME logical attempt (same dispatch/stock/quantity/'
  'override/reason/actor) safe against duplicate dispatch lines or '
  'movements on a lost response. Omitting p_request_id (or NULL, the '
  'default) is fully backward compatible with every existing caller and '
  'behaves exactly as before 106. All prior FEFO/permission/audit behavior '
  'is unchanged.';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. public.phoenix_dispatch_line_requests exists, RLS enabled, org-scoped
--    SELECT only for authenticated (INSERT/UPDATE/DELETE revoked — only the
--    SECURITY DEFINER RPC writes to it).
-- 2. phoenix_add_dispatch_line_fefo_guarded resolves to exactly ONE pg_proc
--    row after this migration (the old 5-arg OID is gone, replaced by the
--    new 6-arg one) — no ambiguous overload exists:
--      SELECT proname, pg_get_function_identity_arguments(oid)
--        FROM pg_proc WHERE proname = 'phoenix_add_dispatch_line_fefo_guarded';
--      -> exactly one row: (p_dispatch_id uuid, p_warehouse_stock_id uuid,
--         p_quantity integer, p_fefo_override boolean, p_override_reason
--         text, p_request_id uuid). Verified empirically against the
--         disposable rig, not merely asserted.
-- 3. p_request_id IS NULL (the default) reproduces 097's exact behavior,
--    byte-for-byte, with zero reads/writes against the new dedup table.
-- 4. 070's phoenix_add_dispatch_line and 097's FEFO/permission/audit logic
--    are completely untouched — same source text as before this migration,
--    only reachable through one additional optional parameter.
-- ============================================================================
-- ROLLBACK:
--   DROP FUNCTION public.phoenix_add_dispatch_line_fefo_guarded(
--     uuid, uuid, integer, boolean, text, uuid);
--   -- then recreate 097's original 5-arg definition from that file, and:
--   DROP TABLE public.phoenix_dispatch_line_requests;
-- ============================================================================
