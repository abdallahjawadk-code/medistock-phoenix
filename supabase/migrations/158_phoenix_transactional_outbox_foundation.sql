-- ============================================================================
-- TRANSACTIONAL-OUTBOX-FOUNDATION-158
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 157.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPE — D2-1 FOUNDATION ONLY
-- ─────────────────────────────────────────────────────────────────────────────
-- This migration creates the outbox table and one internal append helper.
-- It wires NOTHING: no trigger anywhere references either object, no existing
-- writer RPC is touched, and applying this migration alone produces ZERO
-- outbox rows. Producer wiring (extending phoenix_capture_lifecycle_event(),
-- phoenix_capture_movement_posted(), phoenix_capture_stocktake_recorded(), and
-- a new trigger on phoenix_outlet_return_exception_resolutions) is deliberately
-- deferred to separate, independently-gated follow-up migrations (D2-2/D2-3/
-- D2-4), per the owner-approved D2 architecture audit. No consumer, worker,
-- retry, claim, lease, dead-letter, or processing-state concept belongs here —
-- that is D3's own scope, not this migration's.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- STREAM_POSITION — WHAT IT DOES AND DOES NOT MEAN
-- ─────────────────────────────────────────────────────────────────────────────
-- stream_position is a stable technical pagination/tie-break column only. It
-- is NOT a claim of global business ordering, NOT a claim of transaction-
-- commit ordering across unrelated aggregates, and NOT a gap-free sequence
-- (GENERATED ALWAYS AS IDENTITY can skip values on a rolled-back insert
-- attempt, exactly like any other identity/serial column in Postgres). Per-
-- aggregate ordering, when a future consumer needs it, is derived from
-- (aggregate_id, occurred_at, stream_position) — no separate per-aggregate
-- counter is introduced here; none of this repository's own existing ledgers
-- (phoenix_movement_events, 081; phoenix_notifications, 094) have one either,
-- and this migration does not invent a new ordering primitive beyond what
-- those precedents already established.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY event_fingerprint IS A STORED COLUMN, NOT JUST A COMPUTED CHECK
-- ─────────────────────────────────────────────────────────────────────────────
-- The append helper below must be able to distinguish "this exact event_key
-- was already appended with this exact payload" (a safe, idempotent replay —
-- return the existing row) from "this event_key was already appended with a
-- DIFFERENT payload" (a genuine conflict — fail closed). That comparison is
-- impossible without persisting the fingerprint from the first append. This
-- is the same shape as payload_fingerprint on phoenix_dispatch_line_requests
-- (106), phoenix_outlet_return_line_requests (156), and
-- phoenix_outlet_return_exception_resolutions (157) — reused here under a
-- more descriptive name (event_fingerprint) since "event", not "request", is
-- the noun this table is about.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY NO RLS POLICY, UNLIKE phoenix_movement_events / phoenix_notifications
-- ─────────────────────────────────────────────────────────────────────────────
-- Both of those tables grant authenticated a scoped SELECT policy because
-- they are UI-facing read feeds. phoenix_outbox_events has no UI consumer at
-- all — its only future reader is D3's own durable-consumer machinery, which
-- does not exist yet and will need its own access model (service-role or a
-- dedicated claim-based RPC) defined in D3's own migration, not guessed at
-- here. RLS is enabled with ZERO policies, which — combined with the
-- REVOKE ALL below — denies every operation, including SELECT, to every role
-- except the table owner. No diagnostics RPC is created in this migration
-- either; that is an explicit, deliberate exclusion (see the audit report),
-- not an oversight.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY actor_id HAS NO auth.users FOREIGN KEY
-- ─────────────────────────────────────────────────────────────────────────────
-- phoenix_movement_events.actor_id (081) is a bare nullable uuid with no
-- REFERENCES clause — captured from auth.uid() at trigger time, but never
-- constrained to a live row, since some triggers can fire from system
-- context with no authenticated actor. This migration mirrors that exact
-- referential shape rather than inventing a stricter, incompatible contract
-- for a table that otherwise plays the same "captured event ledger" role.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY organization_id IS ON DELETE RESTRICT
-- ─────────────────────────────────────────────────────────────────────────────
-- Same FK behavior as phoenix_movement_events.organization_id (081): an
-- organization that still has outbox events referencing it cannot be
-- deleted out from under them. This fails closed and preserves event
-- integrity, rather than silently orphaning or cascading away rows a future
-- D3 consumer might still need to process.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE HELPER USES AN ADVISORY LOCK *AND* A UNIQUE-CONSTRAINT FALLBACK,
-- NOT BARE `ON CONFLICT DO NOTHING`
-- ─────────────────────────────────────────────────────────────────────────────
-- Every existing idempotency ledger in this repository (106/156/157) takes a
-- per-key advisory lock BEFORE reading/writing its dedup row, so two truly
-- concurrent identical calls serialize and the second observes the first's
-- committed row. This migration does the same (salt 158158, distinct from
-- every other salt already in use in this repository: 106106, 156156,
-- 157157). Unlike those three, this helper ALSO wraps the INSERT itself in a
-- nested exception block that catches unique_violation and reconciles via
-- the same fingerprint-comparison logic used for the pre-check. This makes
-- the UNIQUE(event_key) constraint — not the advisory lock — the true final
-- correctness guarantee: even in a hypothetical future where some caller
-- reached this function without holding the expected lock, two concurrent
-- identical calls still resolve to exactly one row, and two calls with the
-- same key but different content still fail closed, never silently
-- resolving to "do nothing" and returning an unrelated existing row.
-- ============================================================================

BEGIN;

-- ── PRECONDITIONS ───────────────────────────────────────────────────────────

DO $precond$
BEGIN
  IF to_regclass('public.phoenix_outbox_events') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outbox_events already exists (158 already applied?)';
  END IF;
  IF to_regprocedure('public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_append_outbox_event_internal already exists (158 already applied?)';
  END IF;
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public.organizations is missing';
  END IF;
END;
$precond$;

-- ── A. The outbox table — additive, append-only, zero UI-facing access ─────

CREATE TABLE public.phoenix_outbox_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_position   bigint GENERATED ALWAYS AS IDENTITY NOT NULL UNIQUE,
  event_key         text NOT NULL UNIQUE,
  event_fingerprint text NOT NULL,
  event_type        text NOT NULL,
  event_version     smallint NOT NULL DEFAULT 1,
  aggregate_type    text NOT NULL,
  aggregate_id      uuid NOT NULL,
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  actor_id          uuid NULL,
  correlation_id    uuid NULL,
  causation_id      uuid NULL,
  request_id        uuid NULL,
  payload           jsonb NOT NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT poe_event_key_chk
    CHECK (btrim(event_key) = event_key AND event_key <> ''),
  CONSTRAINT poe_event_type_chk
    CHECK (btrim(event_type) = event_type AND event_type <> ''),
  CONSTRAINT poe_aggregate_type_chk
    CHECK (btrim(aggregate_type) = aggregate_type AND aggregate_type <> ''),
  CONSTRAINT poe_event_version_chk
    CHECK (event_version > 0),
  CONSTRAINT poe_payload_object_chk
    CHECK (jsonb_typeof(payload) = 'object')
);

COMMENT ON TABLE public.phoenix_outbox_events IS
  'D2-1 FOUNDATION ONLY. Additive, append-only transactional-outbox event '
  'ledger. Only public.phoenix_append_outbox_event_internal may write to '
  'this table (RLS enabled, zero policies, ALL revoked from PUBLIC/'
  'authenticated/anon). No trigger references this table yet — producer '
  'wiring is deferred to separate follow-up migrations. No consumer exists; '
  'no processing/delivery-state column belongs here (see the helper '
  'function comment and the D2 architecture audit for the full rationale).';

ALTER TABLE public.phoenix_outbox_events ENABLE ROW LEVEL SECURITY;

-- Deliberately zero policies. With RLS enabled and no policy, every
-- operation — including SELECT — is denied by default to every role except
-- the table owner. The REVOKE below makes that denial explicit rather than
-- relying on policy absence alone, matching this repository's established
-- "belt and suspenders" convention (081, 094, 154).
REVOKE ALL ON TABLE public.phoenix_outbox_events FROM PUBLIC, authenticated, anon;

-- ── B. The internal append helper — the ONLY writer this table will ever have ──

CREATE FUNCTION public.phoenix_append_outbox_event_internal(
  p_event_key        text,
  p_event_type       text,
  p_event_version    smallint,
  p_aggregate_type   text,
  p_aggregate_id     uuid,
  p_organization_id  uuid,
  p_payload          jsonb,
  p_actor_id         uuid DEFAULT NULL,
  p_correlation_id   uuid DEFAULT NULL,
  p_causation_id     uuid DEFAULT NULL,
  p_request_id       uuid DEFAULT NULL
)
RETURNS TABLE(event_id uuid, event_stream_position bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $append$
DECLARE
  v_fp       text;
  v_existing record;
  v_new_id   uuid;
  v_new_pos  bigint;
BEGIN
  -- ── Validate every required value before touching the table ──────────────
  IF p_event_key IS NULL OR btrim(p_event_key) = '' THEN
    RAISE EXCEPTION 'outbox_event_key_required' USING ERRCODE = '23514';
  END IF;
  IF p_event_type IS NULL OR btrim(p_event_type) = '' THEN
    RAISE EXCEPTION 'outbox_event_type_required' USING ERRCODE = '23514';
  END IF;
  IF p_event_version IS NULL OR p_event_version <= 0 THEN
    RAISE EXCEPTION 'outbox_event_version_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF p_aggregate_type IS NULL OR btrim(p_aggregate_type) = '' THEN
    RAISE EXCEPTION 'outbox_aggregate_type_required' USING ERRCODE = '23514';
  END IF;
  IF p_aggregate_id IS NULL THEN
    RAISE EXCEPTION 'outbox_aggregate_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'outbox_organization_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'outbox_payload_must_be_object' USING ERRCODE = '23514';
  END IF;

  -- ── Canonical fingerprint over every field that defines this event ───────
  v_fp := encode(sha256(convert_to(jsonb_build_object(
    'event_key', p_event_key,
    'event_type', p_event_type,
    'event_version', p_event_version,
    'aggregate_type', p_aggregate_type,
    'aggregate_id', p_aggregate_id,
    'organization_id', p_organization_id,
    'actor_id', p_actor_id,
    'correlation_id', p_correlation_id,
    'causation_id', p_causation_id,
    'request_id', p_request_id,
    'payload', p_payload
  )::text, 'UTF8')), 'hex');

  -- Serializes truly concurrent identical calls. Salt 158158 is distinct
  -- from every other advisory-lock salt already in use in this repository
  -- (106106, 156156, 157157), so no cross-corridor collision is possible.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_event_key, 158158));

  SELECT e.id, e.stream_position, e.event_fingerprint INTO v_existing
  FROM public.phoenix_outbox_events e
  WHERE e.event_key = p_event_key;

  IF FOUND THEN
    IF v_existing.event_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'outbox_event_key_conflict' USING ERRCODE = '23505',
        DETAIL = 'same event_key previously appended with a different event fingerprint';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.stream_position;
    RETURN;
  END IF;

  -- ── First use of this event_key ───────────────────────────────────────
  -- The UNIQUE(event_key) constraint, not this lock, is the FINAL
  -- correctness guarantee (see the migration header comment). A concurrent
  -- caller that somehow reached this INSERT despite the lock above is
  -- caught here and reconciled the same way as the pre-check — never a
  -- bare ON CONFLICT DO NOTHING silently discarding information about which
  -- payload actually won.
  BEGIN
    INSERT INTO public.phoenix_outbox_events (
      event_key, event_fingerprint, event_type, event_version,
      aggregate_type, aggregate_id, organization_id,
      actor_id, correlation_id, causation_id, request_id, payload
    ) VALUES (
      p_event_key, v_fp, p_event_type, p_event_version,
      p_aggregate_type, p_aggregate_id, p_organization_id,
      p_actor_id, p_correlation_id, p_causation_id, p_request_id, p_payload
    )
    RETURNING phoenix_outbox_events.id, phoenix_outbox_events.stream_position
      INTO v_new_id, v_new_pos;
  EXCEPTION WHEN unique_violation THEN
    SELECT e.id, e.stream_position, e.event_fingerprint INTO v_existing
    FROM public.phoenix_outbox_events e
    WHERE e.event_key = p_event_key;

    IF NOT FOUND OR v_existing.event_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'outbox_event_key_conflict' USING ERRCODE = '23505',
        DETAIL = 'same event_key concurrently appended with a different event fingerprint';
    END IF;

    RETURN QUERY SELECT v_existing.id, v_existing.stream_position;
    RETURN;
  END;

  RETURN QUERY SELECT v_new_id, v_new_pos;
END;
$append$;

COMMENT ON FUNCTION public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid) IS
  'D2-1 FOUNDATION ONLY. The sole writer of phoenix_outbox_events. Inaccessible '
  'to PUBLIC/authenticated/anon (no GRANT is issued to any role in this '
  'migration — future trusted SECURITY DEFINER producer functions, once D2-2/'
  'D2-3/D2-4 wire them, call this by shared ownership, not by ACL grant, '
  'exactly like every other internal helper in this repository). First use '
  'of an event_key inserts a row; a replay with an IDENTICAL fingerprint '
  'returns the existing row unchanged; a replay with a DIFFERENT fingerprint '
  'raises outbox_event_key_conflict. NOT wired into any trigger or business '
  'RPC by this migration — calling it today has no caller anywhere in the '
  'codebase.';

REVOKE ALL ON FUNCTION public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid) FROM PUBLIC, authenticated, anon;

-- =============================================================================
-- VERIFY — inside the transaction; failure rolls back all of 158
-- =============================================================================

DO $$
DECLARE
  v_fn_src      text;
  v_policy_count int;
  v_col_count    int;
BEGIN
  -- 1. Table exists.
  ASSERT to_regclass('public.phoenix_outbox_events') IS NOT NULL,
    'phoenix_outbox_events was not created';

  -- 2. Exactly the 15 approved columns exist.
  SELECT count(*) INTO v_col_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'phoenix_outbox_events'
    AND column_name IN (
      'id','stream_position','event_key','event_fingerprint','event_type',
      'event_version','aggregate_type','aggregate_id','organization_id',
      'actor_id','correlation_id','causation_id','request_id','payload','occurred_at'
    );
  ASSERT v_col_count = 15, format('expected 15 approved columns, found %s', v_col_count);

  -- 3. Required CHECK constraints exist.
  ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.phoenix_outbox_events'::regclass AND conname = 'poe_event_key_chk'),
    'poe_event_key_chk missing';
  ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.phoenix_outbox_events'::regclass AND conname = 'poe_event_type_chk'),
    'poe_event_type_chk missing';
  ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.phoenix_outbox_events'::regclass AND conname = 'poe_aggregate_type_chk'),
    'poe_aggregate_type_chk missing';
  ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.phoenix_outbox_events'::regclass AND conname = 'poe_event_version_chk'),
    'poe_event_version_chk missing';
  ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.phoenix_outbox_events'::regclass AND conname = 'poe_payload_object_chk'),
    'poe_payload_object_chk missing';

  -- 4. RLS enabled, zero policies.
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.phoenix_outbox_events'::regclass),
    'RLS must be enabled on phoenix_outbox_events';
  SELECT count(*) INTO v_policy_count FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'phoenix_outbox_events';
  ASSERT v_policy_count = 0, format('expected zero RLS policies, found %s', v_policy_count);

  -- 5. Table privilege lockdown — authenticated and anon.
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outbox_events', 'SELECT'), 'authenticated must not have SELECT';
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outbox_events', 'INSERT'), 'authenticated must not have INSERT';
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outbox_events', 'UPDATE'), 'authenticated must not have UPDATE';
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outbox_events', 'DELETE'), 'authenticated must not have DELETE';
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outbox_events', 'TRUNCATE'), 'authenticated must not have TRUNCATE';
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outbox_events', 'TRIGGER'), 'authenticated must not have TRIGGER';
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outbox_events', 'REFERENCES'), 'authenticated must not have REFERENCES';
  ASSERT NOT has_table_privilege('anon', 'public.phoenix_outbox_events', 'SELECT'), 'anon must not have SELECT';
  ASSERT NOT has_table_privilege('anon', 'public.phoenix_outbox_events', 'INSERT'), 'anon must not have INSERT';

  -- 6. PUBLIC has no grant either (aclexplode, not a substring/LIKE check).
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
    WHERE c.oid = 'public.phoenix_outbox_events'::regclass AND a.grantee = 0
  ), 'PUBLIC must have no ACL entry at all on phoenix_outbox_events';

  -- 7. event_key and stream_position each carry a real UNIQUE constraint.
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.phoenix_outbox_events'::regclass AND c.contype = 'u'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.phoenix_outbox_events'::regclass AND attname = 'event_key')]
  ), 'event_key must have a single-column UNIQUE constraint';
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.phoenix_outbox_events'::regclass AND c.contype = 'u'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.phoenix_outbox_events'::regclass AND attname = 'stream_position')]
  ), 'stream_position must have a single-column UNIQUE constraint';

  -- 8. Helper exists with its exact documented signature.
  ASSERT to_regprocedure(
    'public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid)'
  ) IS NOT NULL, 'phoenix_append_outbox_event_internal must exist with its documented signature';

  -- 9. Helper is SECURITY DEFINER with search_path pinned.
  SELECT pg_get_functiondef(oid) INTO v_fn_src
    FROM pg_proc WHERE proname = 'phoenix_append_outbox_event_internal';
  ASSERT (
    SELECT prosecdef FROM pg_proc WHERE proname = 'phoenix_append_outbox_event_internal'
  ), 'phoenix_append_outbox_event_internal must be SECURITY DEFINER';
  ASSERT v_fn_src LIKE '%search_path%public%pg_temp%',
    'phoenix_append_outbox_event_internal must keep search_path pinned to public, pg_temp';
  ASSERT v_fn_src LIKE '%outbox_event_key_conflict%',
    'phoenix_append_outbox_event_internal must raise outbox_event_key_conflict on a fingerprint mismatch';
  ASSERT v_fn_src LIKE '%158158%',
    'phoenix_append_outbox_event_internal must use the 158158 advisory-lock salt';

  -- 10. Helper EXECUTE denial — authenticated, anon, and PUBLIC (aclexplode).
  ASSERT NOT has_function_privilege(
    'authenticated',
    'public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid)',
    'EXECUTE'
  ), 'authenticated must not be EXECUTE-granted on the internal append helper';
  ASSERT NOT has_function_privilege(
    'anon',
    'public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid)',
    'EXECUTE'
  ), 'anon must not be EXECUTE-granted on the internal append helper';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
    WHERE p.proname = 'phoenix_append_outbox_event_internal' AND a.grantee = 0
  ), 'PUBLIC must have no ACL entry at all on the internal append helper';

  -- 11. Nothing else was touched — no trigger references either new object.
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE p.proname = 'phoenix_append_outbox_event_internal'
  ), 'no trigger may reference phoenix_append_outbox_event_internal in D2-1';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.phoenix_outbox_events'::regclass AND NOT t.tgisinternal
  ), 'phoenix_outbox_events must carry zero triggers in D2-1';

  -- 12. Applying this migration alone writes zero events.
  ASSERT (SELECT count(*) FROM public.phoenix_outbox_events) = 0,
    'applying 158 must not itself produce any outbox row';
END $$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. public.phoenix_outbox_events exists: 15 approved columns, 5 CHECK
--    constraints, UNIQUE(event_key), UNIQUE(stream_position), RLS enabled
--    with zero policies, ALL revoked from PUBLIC/authenticated/anon
--    (re-verified in-transaction above, including PUBLIC via aclexplode).
-- 2. public.phoenix_append_outbox_event_internal(text,text,smallint,text,
--    uuid,uuid,jsonb,uuid,uuid,uuid,uuid) exists: SECURITY DEFINER, pinned
--    search_path, no GRANT to any role, first-use inserts, identical-replay
--    returns the same row, mismatched-replay raises outbox_event_key_conflict
--    via ERRCODE 23505 (both on the pre-check path and the concurrent
--    unique_violation path).
-- 3. Zero triggers reference either new object. No existing function,
--    trigger, grant, RLS policy, or migration-history behavior through 157
--    is touched by this migration.
-- 4. Zero rows exist in phoenix_outbox_events immediately after this
--    migration commits.
-- 5. RECONCILIATION: this migration writes no application data (one new
--    table + one new function) — nothing to reconcile.
-- ============================================================================
-- ROLLBACK: there is no legitimate reason to ever do this before any
-- follow-up migration depends on these objects. If genuinely required before
-- D2-2/D2-3/D2-4 land:
--   DROP FUNCTION public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid);
--   DROP TABLE public.phoenix_outbox_events;
-- ============================================================================
