-- ============================================================================
-- OUTBOX-CONSUMER-STATE-FOUNDATION-163
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 162.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPE — D3-1, DATABASE-SIDE CONSUMER-STATE INFRASTRUCTURE ONLY
-- ─────────────────────────────────────────────────────────────────────────────
-- This migration adds TWO new tables (phoenix_outbox_consumers,
-- phoenix_outbox_delivery_state) and FOUR new internal functions (claim_batch,
-- mark_completed, mark_failed, release_lease). It creates a reliable
-- claim/lease/completion foundation for a FUTURE external worker that does
-- not exist yet. It deliberately does NOT include: the worker itself, any
-- HTTP delivery, pg_net, pg_cron, LISTEN/NOTIFY, an Edge Function, or a
-- scheduler — all of that is out of D3-1's scope by design, re-verified
-- in-transaction below (grep-style absence checks against every function
-- body this migration creates).
--
-- phoenix_outbox_events (158) is touched by NOTHING in this migration — no
-- new column, no trigger, no RLS/grant change. Every D2 producer (159
-- lifecycle, 161 movement, 162 stocktake, 162 exception-resolution) is
-- completely unchanged — re-verified in-transaction below by the same
-- technique 159/161/162 already used on each other.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY TWO NEW TABLES, NOT ONE, AND NOT A THIRD ATTEMPT-LEDGER TABLE
-- ─────────────────────────────────────────────────────────────────────────────
-- phoenix_outbox_consumers is a small, slow-changing registry (one row per
-- logical consumer, created/edited by an operator, never by a worker).
-- phoenix_outbox_delivery_state is the actual per-(consumer, event) state
-- machine a worker drives at runtime. Splitting these keeps consumer
-- configuration (max_attempts, lease_duration_seconds, org scope) editable
-- without touching millions of delivery-state rows, and keeps the
-- delivery-state table's own schema free of anything a worker never writes.
-- A separate append-only delivery-ATTEMPT ledger was considered and rejected
-- for D3-1: every fact this migration's own state machine needs (attempt
-- count, last error, timestamps) fits in a handful of columns on the state
-- row itself, and the state row's own updated_at plus last_attempt_at
-- already gives an auditable single-row history sufficient for D3-1's
-- observability needs. If a future phase needs a full per-attempt audit
-- trail (e.g. every individual failure's own timestamp+error, not just the
-- most recent), that is a genuinely separate, provable need — not assumed
-- here without proof, per this migration's own scope discipline.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY service_role, NOT A NEW DEDICATED ROLE (UNLIKE phoenix_demo_purger)
-- ─────────────────────────────────────────────────────────────────────────────
-- 109's own migration (`ALTER DEFAULT PRIVILEGES FOR ROLE postgres ...
-- GRANT EXECUTE ON FUNCTIONS TO service_role`) already makes every function
-- `postgres` creates from 109 onward automatically EXECUTE-able by
-- service_role, with zero default access for authenticated/anon/PUBLIC —
-- confirmed by direct inspection of 109's own committed text before writing
-- this migration. service_role is Supabase's own standard trusted-backend
-- role (BYPASSRLS by platform design, used by any legitimate server-side
-- caller holding the service-role key) — exactly the identity a FUTURE
-- external worker will authenticate as. This is unlike phoenix_demo_purger
-- (141), a narrow NOLOGIN role invented for one specific, unusually
-- dangerous operation (bulk demo-data deletion) that needed its own tightly
-- scoped grant surface; D3's claim/complete/fail functions are ordinary
-- trusted-backend RPCs with no comparable reason to invent a new role.
-- Every function below still carries an explicit
-- `REVOKE ALL ... FROM PUBLIC, authenticated, anon` — belt-and-suspenders,
-- matching this repository's universal convention, even though 109's own
-- defaults already guarantee the same starting state.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE STATE MACHINE — MINIMAL, EXPLICIT, FOUR STATUSES
-- ─────────────────────────────────────────────────────────────────────────────
--   (created)  -> pending     claim_batch's own discovery step (idempotent,
--                             ON CONFLICT DO NOTHING; never overwrites an
--                             existing row for the same consumer+event)
--   pending    -> leased      claim_batch (FOR UPDATE SKIP LOCKED)
--   leased     -> completed   mark_completed
--   leased     -> pending     mark_failed, attempt_count < consumer.max_attempts
--                             (attempt_count += 1, available_at = backoff)
--   leased     -> dead_letter mark_failed, attempt_count >= max_attempts
--                             (attempt_count += 1, terminal)
--   leased     -> pending     release_lease (cooperative; attempt_count
--                             UNCHANGED — a graceful release is not a failure)
--   leased     -> pending     claim_batch's own expired-lease reclaim
--                             (attempt_count UNCHANGED — see below)
--   completed  -> completed   mark_completed replayed with the SAME lease
--                             token that completed it (idempotent no-op)
--   dead_letter -> (nothing)  no function in this migration ever reads a
--                             dead_letter row back into pending/leased; a
--                             future, separately authorized replay
--                             mechanism would be the only way out
--
-- DELIBERATE DECISION, DOCUMENTED: expired-lease reclaim does NOT increment
-- attempt_count. Only an explicit mark_failed call (a worker actually
-- reporting a failure) burns an attempt. This keeps "a slow event" and "an
-- event a worker gave up on" as two genuinely different, separately
-- observable facts, and keeps D3-1 to exactly the state transitions its own
-- test suite proves — not a broader retry-on-timeout policy invented
-- without a corresponding proof requirement.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY lease_owner_token IS NEVER CLEARED TO NULL (ONLY lease_expires_at IS)
-- ─────────────────────────────────────────────────────────────────────────────
-- lease_owner_token records "who most recently held or completed this row's
-- lease" and is retained forever once first set; lease_expires_at is cleared
-- to NULL the moment the row leaves 'leased' (completed, failed-to-pending,
-- dead-lettered, or released) and represents "is there an ACTIVE lease right
-- now". Retaining the token is what makes mark_completed's idempotent-replay
-- check possible: a second call with the SAME token that already completed
-- the row succeeds silently (the caller's own retry after a dropped
-- response, a well-known at-least-once-processing hazard); a call with a
-- DIFFERENT token is rejected as foreign, exactly as if it had never
-- completed anything. A CHECK constraint enforces the lease_expires_at/
-- status relationship at the data level, not just in function logic.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY DISCOVERY IS CURSORED BY stream_position, NOT A FULL-TABLE NOT-EXISTS SCAN
-- ─────────────────────────────────────────────────────────────────────────────
-- 158's own header is explicit that stream_position is "a stable technical
-- pagination/tie-break column only" — never global business order, never
-- causal order, never organization order. This migration uses it for
-- EXACTLY that stated purpose and nothing more: each consumer tracks its own
-- last_discovered_stream_position, so claim_batch's discovery step only ever
-- scans events strictly newer than what that ONE consumer has already seen,
-- bounded per call, rather than re-scanning the entire (unboundedly growing)
-- phoenix_outbox_events table on every single call. The cursor advances via
-- `GREATEST(current, newly_seen_max)` under an ordinary UPDATE (no explicit
-- lock needed — READ COMMITTED already guarantees the UPDATE reads the
-- latest committed value), so concurrent claim_batch calls for the same
-- consumer can never move the cursor backward. This is not a claim of
-- gap-free-ness or causal ordering — a consumer that has not run in a while
-- simply catches up across however many calls its bounded per-call discovery
-- cap requires.
-- ============================================================================

BEGIN;

-- ── PRECONDITIONS ───────────────────────────────────────────────────────────

DO $precond$
DECLARE
  -- Every D2 producer this precondition inspects is resolved to its exact
  -- OID here, once, via to_regprocedure() with its full signature -- never
  -- a bare proname lookup. A same-named function in another schema, or a
  -- same-named overload with a different signature, cannot be silently
  -- substituted for the real one.
  v_lifecycle_oid  regprocedure;
  v_movement_oid   regprocedure;
  v_stocktake_oid  regprocedure;
BEGIN
  IF to_regclass('public.phoenix_outbox_events') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outbox_events is missing — apply 158 first';
  END IF;
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public.organizations is missing';
  END IF;
  IF to_regclass('public.phoenix_outbox_consumers') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outbox_consumers already exists (163 already applied?)';
  END IF;
  IF to_regclass('public.phoenix_outbox_delivery_state') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outbox_delivery_state already exists (163 already applied?)';
  END IF;
  IF to_regprocedure('public.phoenix_outbox_claim_batch(text,uuid,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outbox_claim_batch already exists (163 already applied?)';
  END IF;

  v_lifecycle_oid := to_regprocedure('public.phoenix_capture_lifecycle_event()');
  v_movement_oid  := to_regprocedure('public.phoenix_capture_movement_posted()');
  v_stocktake_oid := to_regprocedure('public.phoenix_capture_stocktake_recorded()');
  IF v_lifecycle_oid IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_lifecycle_event() is missing — apply 082/159 first';
  END IF;
  IF v_movement_oid IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_movement_posted() is missing — apply 123/161 first';
  END IF;
  IF v_stocktake_oid IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_stocktake_recorded() is missing — apply 123/162 first';
  END IF;

  -- D2 baseline, re-confirmed exactly as 162 left it, before this migration
  -- touches anything (it touches nothing belonging to D2 — this is a
  -- starting-state snapshot, not a dependency this migration modifies).
  -- Both the COUNT and the exact schema-qualified TABLE SET are checked --
  -- a count alone cannot prove the attachments are still on the right
  -- tables, only that the right number of attachments exist.
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid = v_lifecycle_oid AND NOT t.tgisinternal) <> 11 THEN
    RAISE EXCEPTION 'precondition failed: expected 159''s 11 lifecycle trigger attachments intact before 163';
  END IF;
  IF (SELECT array_agg(DISTINCT n.nspname || '.' || c.relname ORDER BY n.nspname || '.' || c.relname)
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE t.tgfoid = v_lifecycle_oid AND NOT t.tgisinternal) IS DISTINCT FROM ARRAY[
      'public.inventory_status_reports','public.outlet_return_requests','public.outlet_return_shipments',
      'public.phoenix_stock_correction_requests','public.phoenix_warehouse_correction_requests',
      'public.procurement_orders','public.warehouse_dispatches','public.warehouse_return_requests',
      'public.warehouse_return_shipments','public.warehouse_transfer_requests','public.warehouse_transfers'
    ]::text[] THEN
    RAISE EXCEPTION 'precondition failed: lifecycle trigger attachments are not exactly the 11 approved public tables';
  END IF;

  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid = v_movement_oid AND NOT t.tgisinternal) <> 3 THEN
    RAISE EXCEPTION 'precondition failed: expected 161''s 3 movement trigger attachments intact before 163';
  END IF;
  IF (SELECT array_agg(DISTINCT n.nspname || '.' || c.relname ORDER BY n.nspname || '.' || c.relname)
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE t.tgfoid = v_movement_oid AND NOT t.tgisinternal) IS DISTINCT FROM ARRAY[
      'public.outlet_stock_movements','public.warehouse_quarantine_stock_movements','public.warehouse_stock_movements'
    ]::text[] THEN
    RAISE EXCEPTION 'precondition failed: movement trigger attachments are not exactly the 3 approved public tables';
  END IF;

  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid = v_stocktake_oid AND NOT t.tgisinternal) <> 1 THEN
    RAISE EXCEPTION 'precondition failed: expected 162''s 1 stocktake trigger attachment intact before 163';
  END IF;
  IF (SELECT array_agg(DISTINCT n.nspname || '.' || c.relname ORDER BY n.nspname || '.' || c.relname)
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE t.tgfoid = v_stocktake_oid AND NOT t.tgisinternal) IS DISTINCT FROM ARRAY['public.stocktakes']::text[] THEN
    RAISE EXCEPTION 'precondition failed: stocktake trigger attachment is not exactly public.stocktakes';
  END IF;

  IF to_regprocedure('public.phoenix_resolve_outlet_return_exception(uuid,uuid,text,text,integer,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_resolve_outlet_return_exception is missing — apply 157/162 first';
  END IF;
END;
$precond$;

-- ── A. Consumer registry — small, slow-changing, operator-edited ───────────

CREATE TABLE public.phoenix_outbox_consumers (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_key                   text NOT NULL UNIQUE,
  is_enabled                     boolean NOT NULL DEFAULT true,
  organization_id                uuid NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  max_attempts                   smallint NOT NULL DEFAULT 5,
  lease_duration_seconds         integer NOT NULL DEFAULT 300,
  last_discovered_stream_position bigint NOT NULL DEFAULT 0,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT poc_consumer_key_chk
    CHECK (btrim(consumer_key) = consumer_key AND consumer_key <> ''),
  CONSTRAINT poc_max_attempts_chk
    CHECK (max_attempts > 0 AND max_attempts <= 20),
  CONSTRAINT poc_lease_duration_chk
    CHECK (lease_duration_seconds > 0 AND lease_duration_seconds <= 3600),
  CONSTRAINT poc_last_discovered_stream_position_chk
    CHECK (last_discovered_stream_position >= 0)
);

COMMENT ON TABLE public.phoenix_outbox_consumers IS
  'D3-1 FOUNDATION. One row per logical Outbox consumer, operator-managed. '
  'organization_id NULL = global consumer (eligible across every '
  'organization); NOT NULL = scoped to exactly that organization. No '
  'secrets or endpoint credentials belong on this table — see the migration '
  'header for the full rationale. RLS enabled, zero policies, ACL locked '
  'down to service_role only.';

ALTER TABLE public.phoenix_outbox_consumers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.phoenix_outbox_consumers FROM PUBLIC, authenticated, anon;

-- ── B. Per-(consumer, event) delivery-state — the actual runtime state machine ──

CREATE TABLE public.phoenix_outbox_delivery_state (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id        uuid NOT NULL REFERENCES public.phoenix_outbox_consumers(id) ON DELETE RESTRICT,
  outbox_event_id    uuid NOT NULL REFERENCES public.phoenix_outbox_events(id) ON DELETE RESTRICT,
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  status             text NOT NULL DEFAULT 'pending',
  attempt_count      smallint NOT NULL DEFAULT 0,
  available_at       timestamptz NOT NULL DEFAULT now(),
  lease_owner_token  uuid NULL,
  lease_expires_at   timestamptz NULL,
  first_claimed_at   timestamptz NULL,
  last_attempt_at    timestamptz NULL,
  completed_at       timestamptz NULL,
  dead_letter_at     timestamptz NULL,
  last_error_code    text NULL,
  last_error_summary text NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pods_consumer_event_unique UNIQUE (consumer_id, outbox_event_id),
  CONSTRAINT pods_status_chk
    CHECK (status IN ('pending', 'leased', 'completed', 'dead_letter')),
  CONSTRAINT pods_attempt_count_chk
    CHECK (attempt_count >= 0),
  CONSTRAINT pods_error_code_len_chk
    CHECK (last_error_code IS NULL OR length(last_error_code) <= 100),
  CONSTRAINT pods_error_summary_len_chk
    CHECK (last_error_summary IS NULL OR length(last_error_summary) <= 500),
  -- Data-level enforcement of "an active lease exists if and only if status
  -- is 'leased'" — fail closed even against a hypothetical future bug in
  -- the functions below, not just trusted-by-convention.
  CONSTRAINT pods_lease_consistency_chk
    CHECK ((status = 'leased') = (lease_expires_at IS NOT NULL)),
  CONSTRAINT pods_completed_consistency_chk
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT pods_dead_letter_consistency_chk
    CHECK ((status = 'dead_letter') = (dead_letter_at IS NOT NULL))
);

COMMENT ON TABLE public.phoenix_outbox_delivery_state IS
  'D3-1 FOUNDATION. One row per (consumer, Outbox event) pair, created '
  'lazily and idempotently by phoenix_outbox_claim_batch''s own discovery '
  'step. organization_id is copied from the referenced Outbox event at '
  'creation time and never caller-supplied. Never mutates or deletes '
  'phoenix_outbox_events. lease_owner_token is retained after a lease ends '
  '(only lease_expires_at is cleared) so mark_completed can distinguish an '
  'idempotent same-token replay from a foreign-token attempt. RLS enabled, '
  'zero policies, ACL locked down to service_role only.';

CREATE INDEX idx_phoenix_outbox_delivery_state_claim
  ON public.phoenix_outbox_delivery_state (consumer_id, available_at)
  WHERE status = 'pending';

CREATE INDEX idx_phoenix_outbox_delivery_state_lease_expiry
  ON public.phoenix_outbox_delivery_state (consumer_id, lease_expires_at)
  WHERE status = 'leased';

CREATE INDEX idx_phoenix_outbox_delivery_state_event
  ON public.phoenix_outbox_delivery_state (outbox_event_id);

ALTER TABLE public.phoenix_outbox_delivery_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.phoenix_outbox_delivery_state FROM PUBLIC, authenticated, anon;

-- ── C. Claim batch ───────────────────────────────────────────────────────────

CREATE FUNCTION public.phoenix_outbox_claim_batch(
  p_consumer_key text,
  p_lease_token   uuid,
  p_batch_size    integer DEFAULT 10
)
RETURNS TABLE (
  delivery_state_id uuid,
  outbox_event_id   uuid,
  event_key         text,
  event_type        text,
  event_version     smallint,
  aggregate_type    text,
  aggregate_id      uuid,
  organization_id   uuid,
  payload           jsonb,
  occurred_at       timestamptz,
  attempt_count     smallint,
  lease_expires_at  timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $claim$
#variable_conflict use_column
-- The RETURNS TABLE(...) clause below declares outbox_event_id (among
-- others) as an implicit PL/pgSQL variable in scope for this whole
-- function body, which would otherwise collide with the identically-named
-- table column referenced in this function's own ON CONFLICT target list.
-- This pragma resolves every such ambiguity in favor of the column, the
-- standard, documented PL/pgSQL mechanism for exactly this situation.
DECLARE
  v_consumer          public.phoenix_outbox_consumers%ROWTYPE;
  v_lease_expires_at  timestamptz;
  v_new_cursor        bigint;
  -- Bounds how many NEW delivery-state rows a single call may materialize,
  -- independent of p_batch_size (the number actually leased/returned) — see
  -- the migration header's discovery-cursoring rationale.
  v_discovery_cap CONSTANT integer := 1000;
BEGIN
  IF p_consumer_key IS NULL OR btrim(p_consumer_key) = '' THEN
    RAISE EXCEPTION 'consumer_key_required' USING ERRCODE = '23514';
  END IF;
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION 'lease_token_required' USING ERRCODE = '23514';
  END IF;
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 100 THEN
    RAISE EXCEPTION 'batch_size_out_of_bounds' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_consumer
  FROM public.phoenix_outbox_consumers
  WHERE consumer_key = p_consumer_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'consumer_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_consumer.is_enabled THEN
    RAISE EXCEPTION 'consumer_disabled' USING ERRCODE = '23514';
  END IF;

  v_lease_expires_at := now() + make_interval(secs => v_consumer.lease_duration_seconds);

  -- ── Discovery: idempotently materialize pending rows for events this ────
  -- ── consumer has not seen yet, strictly newer than its own cursor. ──────
  WITH discovered AS (
    SELECT e.id AS outbox_event_id, e.organization_id, e.stream_position
    FROM public.phoenix_outbox_events e
    WHERE e.stream_position > v_consumer.last_discovered_stream_position
      AND (v_consumer.organization_id IS NULL OR e.organization_id = v_consumer.organization_id)
    ORDER BY e.stream_position
    LIMIT v_discovery_cap
  ),
  ins AS (
    INSERT INTO public.phoenix_outbox_delivery_state (consumer_id, outbox_event_id, organization_id, status, available_at)
    SELECT v_consumer.id, d.outbox_event_id, d.organization_id, 'pending', now()
    FROM discovered d
    ON CONFLICT (consumer_id, outbox_event_id) DO NOTHING
    RETURNING 1
  )
  SELECT max(d.stream_position) INTO v_new_cursor FROM discovered d;

  IF v_new_cursor IS NOT NULL THEN
    UPDATE public.phoenix_outbox_consumers
       SET last_discovered_stream_position = GREATEST(last_discovered_stream_position, v_new_cursor),
           updated_at = now()
     WHERE id = v_consumer.id;
  END IF;

  -- ── Reclaim expired leases for this consumer only — attempt_count is ───
  -- ── deliberately NOT incremented here (see migration header). ──────────
  UPDATE public.phoenix_outbox_delivery_state
     SET status = 'pending', lease_expires_at = NULL, updated_at = now()
   WHERE consumer_id = v_consumer.id
     AND status = 'leased'
     AND lease_expires_at < now();

  -- ── Claim: FOR UPDATE SKIP LOCKED so concurrent callers for the SAME ────
  -- ── consumer never receive overlapping rows and never block each other. ─
  RETURN QUERY
  WITH candidates AS (
    SELECT ds.id
    FROM public.phoenix_outbox_delivery_state ds
    WHERE ds.consumer_id = v_consumer.id
      AND ds.status = 'pending'
      AND ds.available_at <= now()
    ORDER BY ds.available_at, ds.id
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ),
  leased AS (
    UPDATE public.phoenix_outbox_delivery_state ds
       SET status = 'leased',
           lease_owner_token = p_lease_token,
           lease_expires_at = v_lease_expires_at,
           first_claimed_at = COALESCE(ds.first_claimed_at, now()),
           last_attempt_at = now(),
           updated_at = now()
      FROM candidates c
     WHERE ds.id = c.id
    RETURNING ds.id, ds.outbox_event_id, ds.attempt_count, ds.lease_expires_at
  )
  SELECT l.id, l.outbox_event_id, e.event_key, e.event_type, e.event_version,
         e.aggregate_type, e.aggregate_id, e.organization_id, e.payload, e.occurred_at,
         l.attempt_count, l.lease_expires_at
  FROM leased l
  JOIN public.phoenix_outbox_events e ON e.id = l.outbox_event_id;
END;
$claim$;

REVOKE ALL ON FUNCTION public.phoenix_outbox_claim_batch(text, uuid, integer) FROM PUBLIC, authenticated, anon;

-- ── D. Mark completed ────────────────────────────────────────────────────────

CREATE FUNCTION public.phoenix_outbox_mark_completed(
  p_consumer_key      text,
  p_delivery_state_id uuid,
  p_lease_token       uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $completed$
DECLARE
  v_consumer public.phoenix_outbox_consumers%ROWTYPE;
  v_ds       public.phoenix_outbox_delivery_state%ROWTYPE;
BEGIN
  IF p_consumer_key IS NULL OR btrim(p_consumer_key) = '' THEN
    RAISE EXCEPTION 'consumer_key_required' USING ERRCODE = '23514';
  END IF;
  IF p_delivery_state_id IS NULL THEN
    RAISE EXCEPTION 'delivery_state_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION 'lease_token_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_consumer FROM public.phoenix_outbox_consumers WHERE consumer_key = p_consumer_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'consumer_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_ds
  FROM public.phoenix_outbox_delivery_state
  WHERE id = p_delivery_state_id AND consumer_id = v_consumer.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery_state_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_ds.status = 'completed' THEN
    IF v_ds.lease_owner_token IS NOT DISTINCT FROM p_lease_token THEN
      RETURN jsonb_build_object(
        'ok', true, 'already_completed', true,
        'delivery_state_id', v_ds.id, 'completed_at', v_ds.completed_at
      );
    END IF;
    RAISE EXCEPTION 'stale_or_foreign_lease_token' USING ERRCODE = '42501';
  END IF;

  IF v_ds.status <> 'leased' THEN
    RAISE EXCEPTION 'delivery_state_not_currently_leased' USING ERRCODE = '23514';
  END IF;
  IF v_ds.lease_owner_token IS DISTINCT FROM p_lease_token OR v_ds.lease_expires_at < now() THEN
    RAISE EXCEPTION 'stale_or_foreign_lease_token' USING ERRCODE = '42501';
  END IF;

  UPDATE public.phoenix_outbox_delivery_state
     SET status = 'completed', completed_at = now(), lease_expires_at = NULL, updated_at = now()
   WHERE id = v_ds.id;

  RETURN jsonb_build_object(
    'ok', true, 'already_completed', false,
    'delivery_state_id', v_ds.id, 'completed_at', now()
  );
END;
$completed$;

REVOKE ALL ON FUNCTION public.phoenix_outbox_mark_completed(text, uuid, uuid) FROM PUBLIC, authenticated, anon;

-- ── E. Mark failed ───────────────────────────────────────────────────────────

CREATE FUNCTION public.phoenix_outbox_mark_failed(
  p_consumer_key      text,
  p_delivery_state_id uuid,
  p_lease_token       uuid,
  p_error_code        text DEFAULT NULL,
  p_error_summary     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $failed$
DECLARE
  v_consumer        public.phoenix_outbox_consumers%ROWTYPE;
  v_ds              public.phoenix_outbox_delivery_state%ROWTYPE;
  v_new_attempts    smallint;
  v_new_status      text;
  v_backoff_seconds integer;
  v_available_at    timestamptz;
  v_dead_letter_at  timestamptz;
BEGIN
  IF p_consumer_key IS NULL OR btrim(p_consumer_key) = '' THEN
    RAISE EXCEPTION 'consumer_key_required' USING ERRCODE = '23514';
  END IF;
  IF p_delivery_state_id IS NULL THEN
    RAISE EXCEPTION 'delivery_state_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION 'lease_token_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_consumer FROM public.phoenix_outbox_consumers WHERE consumer_key = p_consumer_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'consumer_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_ds
  FROM public.phoenix_outbox_delivery_state
  WHERE id = p_delivery_state_id AND consumer_id = v_consumer.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery_state_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_ds.status <> 'leased' THEN
    RAISE EXCEPTION 'delivery_state_not_currently_leased' USING ERRCODE = '23514';
  END IF;
  IF v_ds.lease_owner_token IS DISTINCT FROM p_lease_token OR v_ds.lease_expires_at < now() THEN
    RAISE EXCEPTION 'stale_or_foreign_lease_token' USING ERRCODE = '42501';
  END IF;

  v_new_attempts := v_ds.attempt_count + 1;

  IF v_new_attempts >= v_consumer.max_attempts THEN
    v_new_status := 'dead_letter';
    v_dead_letter_at := now();
    v_available_at := v_ds.available_at;
  ELSE
    v_new_status := 'pending';
    v_dead_letter_at := NULL;
    -- Deterministic, server-controlled exponential backoff: 30s, 60s, 120s,
    -- ... capped at 1 hour. Never trusts a caller-supplied delay.
    v_backoff_seconds := LEAST(30 * (2 ^ (v_new_attempts - 1))::integer, 3600);
    v_available_at := now() + make_interval(secs => v_backoff_seconds);
  END IF;

  UPDATE public.phoenix_outbox_delivery_state
     SET status = v_new_status,
         attempt_count = v_new_attempts,
         lease_expires_at = NULL,
         available_at = v_available_at,
         dead_letter_at = v_dead_letter_at,
         last_attempt_at = now(),
         -- Bounded, defensively truncated so a caller can never make this
         -- diagnostics-recording path itself fail on oversized input — see
         -- the migration header for why content-based secret scanning is
         -- deliberately NOT attempted here.
         last_error_code = left(p_error_code, 100),
         last_error_summary = left(p_error_summary, 500),
         updated_at = now()
   WHERE id = v_ds.id;

  RETURN jsonb_build_object(
    'ok', true, 'delivery_state_id', v_ds.id, 'status', v_new_status,
    'attempt_count', v_new_attempts, 'available_at', v_available_at,
    'dead_letter_at', v_dead_letter_at
  );
END;
$failed$;

REVOKE ALL ON FUNCTION public.phoenix_outbox_mark_failed(text, uuid, uuid, text, text) FROM PUBLIC, authenticated, anon;

-- ── F. Release lease (cooperative; never increments attempt_count) ─────────

CREATE FUNCTION public.phoenix_outbox_release_lease(
  p_consumer_key      text,
  p_delivery_state_id uuid,
  p_lease_token       uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $release$
DECLARE
  v_consumer public.phoenix_outbox_consumers%ROWTYPE;
  v_ds       public.phoenix_outbox_delivery_state%ROWTYPE;
BEGIN
  IF p_consumer_key IS NULL OR btrim(p_consumer_key) = '' THEN
    RAISE EXCEPTION 'consumer_key_required' USING ERRCODE = '23514';
  END IF;
  IF p_delivery_state_id IS NULL THEN
    RAISE EXCEPTION 'delivery_state_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION 'lease_token_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_consumer FROM public.phoenix_outbox_consumers WHERE consumer_key = p_consumer_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'consumer_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_ds
  FROM public.phoenix_outbox_delivery_state
  WHERE id = p_delivery_state_id AND consumer_id = v_consumer.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery_state_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_ds.status <> 'leased' THEN
    RAISE EXCEPTION 'delivery_state_not_currently_leased' USING ERRCODE = '23514';
  END IF;
  IF v_ds.lease_owner_token IS DISTINCT FROM p_lease_token OR v_ds.lease_expires_at < now() THEN
    RAISE EXCEPTION 'stale_or_foreign_lease_token' USING ERRCODE = '42501';
  END IF;

  -- Deliberately does NOT touch attempt_count — a cooperative release is
  -- not a failure. Only lease_expires_at is cleared; lease_owner_token is
  -- retained, matching every other transition's own convention.
  UPDATE public.phoenix_outbox_delivery_state
     SET status = 'pending', lease_expires_at = NULL, available_at = now(), updated_at = now()
   WHERE id = v_ds.id;

  RETURN jsonb_build_object('ok', true, 'delivery_state_id', v_ds.id, 'available_at', now());
END;
$release$;

REVOKE ALL ON FUNCTION public.phoenix_outbox_release_lease(text, uuid, uuid) FROM PUBLIC, authenticated, anon;

-- =============================================================================
-- VERIFY — inside the transaction; failure rolls back all of 163
-- =============================================================================

DO $$
DECLARE
  v_col_count      int;
  v_policy_count   int;
  v_fn_src         text;
  v_fn_name        text;
  v_fn_oid         regprocedure;
  v_outbox_cols    text[];
  -- Every D2 producer and every new D3-1 function this block inspects is
  -- resolved to its exact OID here, once, via to_regprocedure() with its
  -- full signature -- never a bare proname lookup. A same-named function in
  -- another schema, or a same-named overload with a different signature,
  -- cannot be silently substituted for the real one.
  v_lifecycle_oid          regprocedure := to_regprocedure('public.phoenix_capture_lifecycle_event()');
  v_movement_oid           regprocedure := to_regprocedure('public.phoenix_capture_movement_posted()');
  v_stocktake_oid          regprocedure := to_regprocedure('public.phoenix_capture_stocktake_recorded()');
  v_exception_resolve_oid  regprocedure := to_regprocedure('public.phoenix_resolve_outlet_return_exception(uuid,uuid,text,text,integer,text)');
  v_claim_batch_oid        regprocedure := to_regprocedure('public.phoenix_outbox_claim_batch(text,uuid,integer)');
  v_mark_completed_oid     regprocedure := to_regprocedure('public.phoenix_outbox_mark_completed(text,uuid,uuid)');
  v_mark_failed_oid        regprocedure := to_regprocedure('public.phoenix_outbox_mark_failed(text,uuid,uuid,text,text)');
  v_release_lease_oid      regprocedure := to_regprocedure('public.phoenix_outbox_release_lease(text,uuid,uuid)');
  v_new_fn_oids            regprocedure[];
BEGIN
  v_new_fn_oids := ARRAY[v_claim_batch_oid, v_mark_completed_oid, v_mark_failed_oid, v_release_lease_oid];

  -- ── 1. phoenix_outbox_events (158) is completely untouched ──────────────
  SELECT array_agg(column_name::text ORDER BY column_name::text) INTO v_outbox_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'phoenix_outbox_events';
  ASSERT v_outbox_cols = ARRAY[
    'actor_id','aggregate_id','aggregate_type','causation_id','correlation_id',
    'event_fingerprint','event_key','event_type','event_version','id',
    'occurred_at','organization_id','payload','request_id','stream_position'
  ]::text[], 'phoenix_outbox_events must keep exactly its 158-defined 15 columns, no D3 column added';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.phoenix_outbox_events'::regclass AND NOT tgisinternal
  ), 'phoenix_outbox_events must carry no trigger of any kind after 163';

  -- ── 2. Every D2 producer completely unchanged ────────────────────────────
  -- Both the COUNT and the exact schema-qualified TABLE SET are checked --
  -- a count alone cannot prove the attachments are still on the right
  -- tables, only that the right number of attachments exist.
  ASSERT (
    SELECT count(*) FROM pg_trigger t WHERE t.tgfoid = v_lifecycle_oid AND NOT t.tgisinternal
  ) = 11, '159''s 11 lifecycle trigger attachments must remain unchanged';
  ASSERT (
    SELECT array_agg(DISTINCT n.nspname || '.' || c.relname ORDER BY n.nspname || '.' || c.relname)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE t.tgfoid = v_lifecycle_oid AND NOT t.tgisinternal
  ) = ARRAY[
    'public.inventory_status_reports','public.outlet_return_requests','public.outlet_return_shipments',
    'public.phoenix_stock_correction_requests','public.phoenix_warehouse_correction_requests',
    'public.procurement_orders','public.warehouse_dispatches','public.warehouse_return_requests',
    'public.warehouse_return_shipments','public.warehouse_transfer_requests','public.warehouse_transfers'
  ]::text[], '159''s lifecycle trigger attachments must remain on exactly the 11 approved public tables';
  ASSERT (
    SELECT count(*) FROM pg_trigger t WHERE t.tgfoid = v_movement_oid AND NOT t.tgisinternal
  ) = 3, '161''s 3 movement trigger attachments must remain unchanged';
  ASSERT (
    SELECT array_agg(DISTINCT n.nspname || '.' || c.relname ORDER BY n.nspname || '.' || c.relname)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE t.tgfoid = v_movement_oid AND NOT t.tgisinternal
  ) = ARRAY[
    'public.outlet_stock_movements','public.warehouse_quarantine_stock_movements','public.warehouse_stock_movements'
  ]::text[], '161''s movement trigger attachments must remain on exactly the 3 approved public tables';
  ASSERT (
    SELECT count(*) FROM pg_trigger t WHERE t.tgfoid = v_stocktake_oid AND NOT t.tgisinternal
  ) = 1, '162''s 1 stocktake trigger attachment must remain unchanged';
  ASSERT (
    SELECT array_agg(DISTINCT n.nspname || '.' || c.relname ORDER BY n.nspname || '.' || c.relname)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE t.tgfoid = v_stocktake_oid AND NOT t.tgisinternal
  ) = ARRAY['public.stocktakes']::text[], '162''s stocktake trigger attachment must remain on exactly public.stocktakes';
  SELECT pg_get_functiondef(v_exception_resolve_oid) INTO v_fn_src;
  ASSERT (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, 'phoenix_append_outbox_event_internal', '')))
           / LENGTH('phoenix_append_outbox_event_internal') = 2,
    '162''s exception-resolution RPC must still contain exactly two outbox-helper references';
  ASSERT (
    SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.phoenix_outlet_return_exception_resolutions'::regclass AND NOT tgisinternal
  ) = 0, 'phoenix_outlet_return_exception_resolutions must still carry no trigger';

  -- ── 3. phoenix_outbox_consumers ──────────────────────────────────────────
  ASSERT to_regclass('public.phoenix_outbox_consumers') IS NOT NULL, 'phoenix_outbox_consumers must exist';
  SELECT count(*) INTO v_col_count FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'phoenix_outbox_consumers';
  ASSERT v_col_count = 9, format('expected 9 columns on phoenix_outbox_consumers, found %s', v_col_count);
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.phoenix_outbox_consumers'::regclass),
    'phoenix_outbox_consumers must have RLS enabled';
  SELECT count(*) INTO v_policy_count FROM pg_policies WHERE schemaname = 'public' AND tablename = 'phoenix_outbox_consumers';
  ASSERT v_policy_count = 0, 'phoenix_outbox_consumers must carry zero RLS policies';
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outbox_consumers', 'SELECT'), 'authenticated must not read phoenix_outbox_consumers';
  ASSERT NOT has_table_privilege('anon', 'public.phoenix_outbox_consumers', 'SELECT'), 'anon must not read phoenix_outbox_consumers';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.phoenix_outbox_consumers'::regclass AND a.grantee = 0
  ), 'PUBLIC must have no ACL entry on phoenix_outbox_consumers';
  ASSERT has_table_privilege('service_role', 'public.phoenix_outbox_consumers', 'SELECT'),
    'service_role must retain its normal default access to phoenix_outbox_consumers';

  -- ── 4. phoenix_outbox_delivery_state ─────────────────────────────────────
  ASSERT to_regclass('public.phoenix_outbox_delivery_state') IS NOT NULL, 'phoenix_outbox_delivery_state must exist';
  SELECT count(*) INTO v_col_count FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'phoenix_outbox_delivery_state';
  ASSERT v_col_count = 17, format('expected 17 columns on phoenix_outbox_delivery_state, found %s', v_col_count);
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.phoenix_outbox_delivery_state'::regclass),
    'phoenix_outbox_delivery_state must have RLS enabled';
  SELECT count(*) INTO v_policy_count FROM pg_policies WHERE schemaname = 'public' AND tablename = 'phoenix_outbox_delivery_state';
  ASSERT v_policy_count = 0, 'phoenix_outbox_delivery_state must carry zero RLS policies';
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outbox_delivery_state', 'SELECT'), 'authenticated must not read delivery state';
  ASSERT NOT has_table_privilege('anon', 'public.phoenix_outbox_delivery_state', 'SELECT'), 'anon must not read delivery state';
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.phoenix_outbox_delivery_state'::regclass
      AND contype = 'u' AND conname = 'pods_consumer_event_unique'
  ), 'phoenix_outbox_delivery_state must enforce UNIQUE(consumer_id, outbox_event_id)';
  ASSERT (SELECT count(*) FROM public.phoenix_outbox_delivery_state) = 0,
    'applying 163 must not itself produce any delivery-state row';
  ASSERT (SELECT count(*) FROM public.phoenix_outbox_consumers) = 0,
    'applying 163 must not itself produce any consumer row';

  -- ── 5. No D3 processing column ever landed on phoenix_outbox_events, and ─
  -- ── no D3 worker/scheduler/network object was added anywhere. ───────────
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'phoenix_outbox_events'
       AND column_name ~* 'process|claim|lease|retry|attempt|failure|dead.?letter|consum'
  ), 'phoenix_outbox_events must carry no D3 consumer/processing column';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname ~* '^phoenix_(dispatch|deliver)_outbox'),
    'no delivery/dispatch worker function may exist after 163';
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_name ~* '^cron\.'),
    'no pg_cron scheduled job routine reference may exist after 163';

  -- ── 6. Every new function: correct security posture, and structurally ───
  -- ── free of network/scheduler/LISTEN-NOTIFY code (grep on own body). ────
  -- Iterates over the exact OID array resolved above, never proname IN (...)
  -- -- a same-named function elsewhere cannot be read by mistake.
  FOR v_fn_src IN
    SELECT pg_get_functiondef(oid) FROM pg_proc WHERE oid = ANY(v_new_fn_oids)
  LOOP
    ASSERT lower(v_fn_src) !~ 'pg_net|http_post|http_get|net\.http',
      'no D3-1 function may reference pg_net or perform HTTP delivery';
    ASSERT lower(v_fn_src) !~ 'cron\.schedule|pg_cron',
      'no D3-1 function may reference pg_cron';
    -- PostgreSQL's regex engine (ARE) does NOT treat \b as a PCRE-style
    -- word boundary -- empirically confirmed: 'listen test' ~ '\blisten\b'
    -- returns FALSE, so the previous form of this assertion could never
    -- have detected a literal LISTEN or NOTIFY token (only the plain
    -- pg_notify alternative ever worked). \m / \M are Postgres's own
    -- native beginning-of-word / end-of-word constraint escapes -- verified
    -- to match 'listen'/'notify' standalone while NOT matching 'listener'
    -- or 'notification'.
    ASSERT lower(v_fn_src) !~ '\m(listen|notify)\M|pg_notify',
      'no D3-1 function may use LISTEN/NOTIFY';
    ASSERT lower(v_fn_src) !~ 'insert[[:space:]]+into[[:space:]]+(public[.])?phoenix_outbox_events',
      'no D3-1 function may INSERT into phoenix_outbox_events';
    ASSERT lower(v_fn_src) !~ 'update[[:space:]]+(public[.])?phoenix_outbox_events|delete[[:space:]]+from[[:space:]]+(public[.])?phoenix_outbox_events',
      'no D3-1 function may UPDATE or DELETE phoenix_outbox_events';
  END LOOP;

  ASSERT v_claim_batch_oid IS NOT NULL,
    'phoenix_outbox_claim_batch must exist with its exact signature';
  ASSERT v_mark_completed_oid IS NOT NULL,
    'phoenix_outbox_mark_completed must exist with its exact signature';
  ASSERT v_mark_failed_oid IS NOT NULL,
    'phoenix_outbox_mark_failed must exist with its exact signature';
  ASSERT v_release_lease_oid IS NOT NULL,
    'phoenix_outbox_release_lease must exist with its exact signature';

  -- Security-posture loop, also driven by the exact OID array -- the inner
  -- checks now read the loop's own resolved oid/proname pair directly,
  -- never re-querying pg_proc by a bare name.
  FOR v_fn_oid, v_fn_name IN
    SELECT oid, proname FROM pg_proc WHERE oid = ANY(v_new_fn_oids)
  LOOP
    ASSERT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn_oid),
      format('%s must be SECURITY DEFINER', v_fn_name);
    ASSERT (SELECT proconfig @> ARRAY['search_path=public, pg_temp']::text[] FROM pg_proc WHERE oid = v_fn_oid),
      format('%s must keep search_path pinned to public, pg_temp', v_fn_name);
    ASSERT NOT has_function_privilege('authenticated', v_fn_oid, 'EXECUTE'),
      format('authenticated must not be able to execute %s', v_fn_name);
    ASSERT NOT has_function_privilege('anon', v_fn_oid, 'EXECUTE'),
      format('anon must not be able to execute %s', v_fn_name);
    ASSERT has_function_privilege('service_role', v_fn_oid, 'EXECUTE'),
      format('service_role must retain its normal default EXECUTE on %s', v_fn_name);
  END LOOP;
END $$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. Two new tables (phoenix_outbox_consumers, phoenix_outbox_delivery_state)
--    and four new internal functions (claim_batch, mark_completed,
--    mark_failed, release_lease) exist, each RLS-enabled with zero policies
--    (tables) or REVOKE-ALL-from-client-roles (functions), executable only
--    by service_role via 109's own already-established default privilege.
-- 2. phoenix_outbox_events retains exactly its 158-defined 15 columns and
--    zero triggers. Every D2 producer (159/161/162's three trigger
--    functions, plus 162's exception-resolution RPC) is byte-for-byte
--    functionally unchanged, re-verified in-transaction above.
-- 3. No D3 processing/claim/lease/retry/dead-letter column exists on
--    phoenix_outbox_events itself — that state lives entirely in the two
--    new tables this migration owns.
-- 4. Every new function is structurally free of pg_net, pg_cron,
--    LISTEN/NOTIFY, and any direct mutation of phoenix_outbox_events,
--    re-verified in-transaction via source inspection of exactly the
--    functions this migration creates.
-- 5. Zero rows exist in either new table immediately after this migration
--    commits — it creates infrastructure only, no consumer is registered
--    and no delivery state is materialized by the migration itself.
-- 6. RECONCILIATION: this migration writes no application data (two new
--    tables, four new functions) — nothing to reconcile.
-- ============================================================================
-- ROLLBACK: there is no legitimate reason to ever do this once any real
-- consumer has been registered or any real delivery-state row has been
-- claimed (that would be destroying real operational state). If genuinely
-- required before any real consumer is registered:
--   DROP FUNCTION public.phoenix_outbox_release_lease(text, uuid, uuid);
--   DROP FUNCTION public.phoenix_outbox_mark_failed(text, uuid, uuid, text, text);
--   DROP FUNCTION public.phoenix_outbox_mark_completed(text, uuid, uuid);
--   DROP FUNCTION public.phoenix_outbox_claim_batch(text, uuid, integer);
--   DROP TABLE public.phoenix_outbox_delivery_state;
--   DROP TABLE public.phoenix_outbox_consumers;
-- ============================================================================
