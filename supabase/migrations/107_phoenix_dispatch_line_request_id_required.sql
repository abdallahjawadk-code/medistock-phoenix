-- ============================================================================
-- DISPATCH-LINE-REQUEST-ID-REQUIRED-107-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 106.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES (Phase 2 closure gap 1)
-- ─────────────────────────────────────────────────────────────────────────────
-- 106 made p_request_id an OPTIONAL, NULL-safe trailing parameter on
-- phoenix_add_dispatch_line_fefo_guarded, specifically so every EXISTING
-- caller (none of which passed a request id yet) kept working unmodified.
-- That transition period is over: 106's own follow-up commit
-- (6db7204, "wire 106's dispatch-line request id into the composer") already
-- updated the ONLY reachable call site in src/ (OutletDispatchComposer.tsx,
-- via dispatch.service.ts's addDispatchLine) to always derive and pass a
-- request id. With no legitimate caller left that omits it, NULL is no
-- longer "an caller that hasn't upgraded yet" — it is a live bypass: ANY
-- authenticated session (a hand-crafted RPC call, not just the reviewed UI)
-- can still omit p_request_id and fall through to the OLD, non-idempotent
-- 097 path, defeating 106's entire purpose. Idempotency must now be a
-- REQUIRED server-side property of this RPC, not an opt-in.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- CONTRACT CHOSEN
-- ─────────────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE the SAME 6-parameter signature 106 already settled on
-- (uuid,uuid,integer,boolean,text,uuid) — confirmed via pg_proc (see the 106
-- dynamic test "resolves to exactly ONE pg_proc row") that this is a
-- same-signature replace, not a second overload, so CREATE OR REPLACE here
-- is safe and keeps exactly one pg_proc row for this function name.
--
-- Rather than dropping the DEFAULT NULL (which would change the function's
-- calling convention for any 3/4/5-positional-arg caller and reintroduce the
-- exact overload-ambiguity trap 106's own header warns about for callers
-- using named JSON arguments), the DEFAULT stays for Postgres syntax
-- reasons, and a fail-closed guard is added as the FIRST statement in the
-- function body:
--   IF p_request_id IS NULL THEN RAISE EXCEPTION 'request_id_required' ...
-- This runs before ANY read or write — including the dispatch/stock lookups,
-- the idempotency-gate block, and the FEFO/permission logic — so a rejected
-- NULL call never touches warehouse_dispatch_lines, warehouse_stock_movements,
-- or phoenix_dispatch_line_requests: a partial write on a rejected call would
-- itself be a defect, and this migration is proven (via the 107 dynamic
-- test) to leave zero rows anywhere on that path.
--
-- Every other behavior 106 built — same request_id+payload replay, same
-- request_id+different payload 23505 conflict, concurrent-duplicate-request
-- serialization via the per-request advisory xact lock — is completely
-- unchanged; this migration only removes the NULL bypass.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure(
    'public.phoenix_add_dispatch_line_fefo_guarded(uuid,uuid,integer,boolean,text,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 106 phoenix_add_dispatch_line_fefo_guarded(...,uuid) is missing';
  END IF;
  IF to_regclass('public.phoenix_dispatch_line_requests') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 106 phoenix_dispatch_line_requests is missing';
  END IF;
END;
$precond$;

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
  -- ── 107: fail-closed FIRST — before any lookup, read, or write ───────────
  -- NULL is no longer "not yet opted in"; it is rejected outright, with
  -- nothing written anywhere on this path.
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514',
      DETAIL = 'phoenix_add_dispatch_line_fefo_guarded requires a client-supplied p_request_id as of migration 107 — every reviewed caller in src/ already derives one via operation-token.ts';
  END IF;

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

  -- ── Idempotency gate — unchanged from 106, now unconditionally reached ───
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
    -- permitted, and reasoned. (Unchanged from 097/106.)
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
    -- delegation, no override machinery, no audit noise. (Unchanged from 097/106.)
    v_result := public.phoenix_add_dispatch_line(p_dispatch_id, p_warehouse_stock_id, p_quantity)
                 || jsonb_build_object('fefo_override_applied', false);
  END IF;

  -- ── Record the dedup row in the SAME transaction as the mutation above ──
  INSERT INTO public.phoenix_dispatch_line_requests (
    request_id, organization_id, dispatch_id, payload_fingerprint, result, dispatch_line_id, actor_id
  ) VALUES (
    p_request_id, v_dispatch.organization_id, p_dispatch_id, v_fp, v_result,
    NULLIF(v_result ->> 'dispatch_line_id', '')::uuid, v_actor
  );

  RETURN v_result;
END;
$fefo$;

REVOKE ALL ON FUNCTION public.phoenix_add_dispatch_line_fefo_guarded(uuid, uuid, integer, boolean, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_add_dispatch_line_fefo_guarded(uuid, uuid, integer, boolean, text, uuid) TO authenticated;

COMMENT ON FUNCTION public.phoenix_add_dispatch_line_fefo_guarded(uuid, uuid, integer, boolean, text, uuid) IS
  'FEFO-enforced wrapper over 070''s phoenix_add_dispatch_line (097), with a '
  'REQUIRED server-side idempotency key (107, tightened from 106''s optional '
  'one): p_request_id IS NULL is now rejected with request_id_required '
  'before any read or write. Every reviewed caller in src/ derives one via '
  'operation-token.ts. All FEFO/permission/audit behavior and the replay/'
  'conflict/concurrency dedup contract established in 106 are unchanged.';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. phoenix_add_dispatch_line_fefo_guarded resolves to exactly ONE pg_proc
--    row after this migration (same signature as 106, CREATE OR REPLACE in
--    place, no new overload):
--      SELECT count(*) FROM pg_proc WHERE proname = 'phoenix_add_dispatch_line_fefo_guarded';
--      -> 1
-- 2. Calling with p_request_id NULL/omitted raises 'request_id_required'
--    (ERRCODE 23514) and writes NOTHING to warehouse_dispatch_lines,
--    warehouse_stock_movements, or phoenix_dispatch_line_requests.
-- 3. 106's replay / 23505-conflict / concurrent-duplicate contract is
--    unchanged for every call that DOES supply a request id.
-- ============================================================================
-- ROLLBACK:
--   CREATE OR REPLACE the 106 definition of
--   phoenix_add_dispatch_line_fefo_guarded(uuid, uuid, integer, boolean,
--   text, uuid) from 106_phoenix_dispatch_line_idempotency.sql verbatim,
--   which restores the NULL-permits-the-old-path behavior.
-- ============================================================================
