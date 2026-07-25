-- ============================================================================
-- CUSTODY-CHAIN-NOTIFICATIONS-094-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply AFTER 082 (it redefines the exact function 082 created) and AFTER 093
-- (this is the first migration of the Phase 2 closed-custody-chain package,
-- stacked on PR #46 / migration 093).
--
-- VERIFICATION STATUS: pre-merge validation is static analysis + the dynamic
-- rig test in this same commit, run against a disposable PostgreSQL 18.4
-- cluster with 001-094 applied in order. NOT applied to production.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS CLOSES — PHASE 2 CONTRACT ITEM: "persistent server-side
-- notifications (unread badge, deep link, dedup, audit)"
-- ─────────────────────────────────────────────────────────────────────────────
-- A prior audit (see the Phase-2 survey preceding this migration) confirmed no
-- such mechanism exists anywhere in 001-093. The only adjacent feature is
-- 056's platform_broadcast_* tables, which are admin-authored announcements,
-- not per-event operational notifications derived from the custody chain
-- itself. This migration adds that missing piece.
--
-- SCOPE OF THIS FIRST INCREMENT (Phase 2a — honest partial coverage, like
-- 081's own `complete:false` timeline): notifications are emitted for every
-- status transition the 082 lifecycle-capture trigger already observes on the
-- six corridor headers (warehouse_transfer_requests, warehouse_return_requests,
-- warehouse_return_shipments, outlet_return_requests, outlet_return_shipments,
-- warehouse_dispatches). Local procurement (087), quarantine disposition
-- changes, and the monthly status center (092) are NOT wired to notifications
-- in this migration — that is deliberately left for a follow-up Phase 2
-- increment, not silently assumed done here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS EXTENDS 082's TRIGGER FUNCTION INSTEAD OF ADDING NEW TRIGGERS
-- ─────────────────────────────────────────────────────────────────────────────
-- 082 already fires transactionally, exactly once per genuine status
-- transition, with idempotency already solved (dedupe_key, ON CONFLICT DO
-- NOTHING) and the actor/org resolution already correct. Adding a second,
-- independent trigger to compute the same "is this a real transition"
-- decision a second time would risk the two triggers disagreeing under
-- concurrent writes. Instead this migration redefines
-- phoenix_capture_lifecycle_event with the SAME signature (no new trigger
-- objects, the six existing triggers keep calling the same function name) and
-- adds one more INSERT, inside the same transaction, guarded by the same
-- "only on a genuine status change" branch.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY NOTIFICATIONS STAY SINGLE-ORG SCOPED (v_home_org), NOT BOTH ENDPOINTS
-- ─────────────────────────────────────────────────────────────────────────────
-- 081/082 already made this same call for the ledger and documented it as "a
-- deliberate future decision, not silently assumed here". This migration
-- keeps the same posture for notifications: widening either mechanism to the
-- counterparty organization is a real product decision (what should the
-- OTHER side of a corridor be told, and when) that deserves its own reviewed
-- migration, not an incidental side effect of adding notifications.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY READ-STATE IS A SEPARATE TABLE, NOT A COLUMN ON THE NOTIFICATION
-- ─────────────────────────────────────────────────────────────────────────────
-- A notification is org-scoped (every active profile in the organization can
-- see it), but "read" is inherently per-viewer: one officer opening it must
-- not mark it read for a colleague in the same org. A single mutable
-- `read_at` column on the notification row cannot represent that. A join
-- table (notification_id, profile_id) keyed by the pair, written exactly once
-- per viewer via ON CONFLICT DO NOTHING, gives each profile independent,
-- idempotent read state without fanning the notification itself out into one
-- row per recipient.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY EVERY WRITE PATH IS AN RPC, NOT A GRANTED TABLE PRIVILEGE
-- ─────────────────────────────────────────────────────────────────────────────
-- Consistent with 085's "no manual writers" posture and the D2 access-control
-- contract landed in migration 093: `authenticated` gets SELECT on
-- phoenix_notifications only (scoped by RLS, mirroring 081's ledger policy)
-- and NOTHING on phoenix_notification_reads — marking read/unread is only
-- reachable through phoenix_notifications_mark_read /
-- _mark_all_read, so a caller can never mark a notification read for a
-- DIFFERENT profile_id, and never for a notification outside their own org
-- scope. Both RPCs are silently no-op (not an error) when the id is invisible
-- or unknown to the caller, matching phoenix_movement_timeline's existing
-- "unauthorized and nonexistent are indistinguishable" rule — this migration
-- does not reintroduce an existence-oracle error, and writes nothing to
-- public.profiles directly (all profile identity/role reads are read-only
-- lookups against the caller's own row).
-- ============================================================================

BEGIN;

-- ── PRECONDITIONS ───────────────────────────────────────────────────────────

DO $precond$
BEGIN
  IF to_regclass('public.phoenix_movement_events') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_movement_events is missing — apply 081 first';
  END IF;
  IF to_regprocedure('public.phoenix_capture_lifecycle_event()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_lifecycle_event() is missing — apply 082 first';
  END IF;
  IF to_regclass('public.phoenix_notifications') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_notifications already exists (094 already applied?)';
  END IF;
  IF to_regprocedure('public.phoenix_my_role()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public.phoenix_my_role() is missing';
  END IF;
END;
$precond$;

-- ── A. The notification feed (org-scoped, append-only) ─────────────────────

CREATE TABLE public.phoenix_notifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  event_type         text NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  actor_id           uuid,
  actor_role         text,
  actor_name         text,
  status_after       text,
  reference_type     text,
  reference_id       uuid,
  reference_label    text,
  dedupe_key         text,
  CONSTRAINT phoenix_notifications_type_chk
    CHECK (btrim(event_type) = event_type AND event_type <> '')
);

COMMENT ON TABLE public.phoenix_notifications IS
  'APPEND-ONLY, org-scoped operational notification feed derived from custody-'
  'chain lifecycle transitions. Never UPDATEd or DELETEd — a row is itself the '
  'audit record. Per-viewer read state lives in phoenix_notification_reads, '
  'never as a column here. Populated only by phoenix_capture_lifecycle_event '
  '(SECURITY DEFINER); authenticated has SELECT only.';

CREATE UNIQUE INDEX phoenix_notifications_dedupe_uniq
  ON public.phoenix_notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX phoenix_notifications_org_feed_idx
  ON public.phoenix_notifications (organization_id, occurred_at DESC, id DESC);

ALTER TABLE public.phoenix_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY phoenix_notifications_select_scoped
  ON public.phoenix_notifications
  FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'super_admin'
    OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
  );

REVOKE INSERT, UPDATE, DELETE ON TABLE public.phoenix_notifications FROM authenticated;
GRANT SELECT ON TABLE public.phoenix_notifications TO authenticated;

-- ── B. Per-viewer read state ────────────────────────────────────────────────

CREATE TABLE public.phoenix_notification_reads (
  notification_id  uuid NOT NULL REFERENCES public.phoenix_notifications(id) ON DELETE CASCADE,
  profile_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  read_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, profile_id)
);

COMMENT ON TABLE public.phoenix_notification_reads IS
  'Per-viewer read state for phoenix_notifications. One row per (notification, '
  'profile), written exactly once via ON CONFLICT DO NOTHING by '
  'phoenix_notifications_mark_read/_mark_all_read. NO direct grants to '
  'authenticated at all — reachable only through those two RPCs, so a caller '
  'can never write a read row for a profile_id other than their own.';

CREATE INDEX phoenix_notification_reads_profile_idx
  ON public.phoenix_notification_reads (profile_id, notification_id);

ALTER TABLE public.phoenix_notification_reads ENABLE ROW LEVEL SECURITY;
-- No policy is defined: with RLS enabled and no GRANT, `authenticated` has
-- zero reachable rows through PostgREST or direct SQL — everything routes
-- through the SECURITY DEFINER RPCs below.
REVOKE ALL ON TABLE public.phoenix_notification_reads FROM authenticated;

-- ── C. Extend the lifecycle-capture trigger to also emit a notification ────
-- Full redefinition, same signature/name as 082. The movement_events INSERT
-- below is byte-for-byte what 082 shipped; only the new notifications INSERT
-- is added, guarded by the identical "real transition" branch above it.

CREATE OR REPLACE FUNCTION public.phoenix_capture_lifecycle_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $capture$
DECLARE
  v_new        jsonb := to_jsonb(NEW);
  v_old        jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  v_new_status text  := v_new ->> 'status';
  v_old_status text  := v_old ->> 'status';
  v_actor      uuid  := auth.uid();
  v_home_col   text  := TG_ARGV[0];
  v_home_org   uuid;
  v_src_org    uuid  := NULLIF(COALESCE(v_new ->> 'source_organization_id', v_new ->> 'organization_id'), '')::uuid;
  v_dst_org    uuid  := NULLIF(v_new ->> 'destination_organization_id', '')::uuid;
  v_role       text;
  v_name       text;
  v_doc        text  := COALESCE(v_new ->> 'request_number', v_new ->> 'return_number',
                                 v_new ->> 'shipment_number', v_new ->> 'dispatch_number');
  v_dedupe     text;
BEGIN
  -- Only real transitions. Same-value UPDATEs (metadata edits, second partial
  -- send that leaves status unchanged) never emit an event or a notification.
  IF v_new_status IS NULL OR v_new_status IS NOT DISTINCT FROM v_old_status THEN
    RETURN NEW;
  END IF;

  v_home_org := NULLIF(v_new ->> v_home_col, '')::uuid;
  IF v_home_org IS NULL THEN
    v_home_org := COALESCE(v_src_org, v_dst_org);  -- never leave RLS owner NULL
  END IF;

  IF v_actor IS NOT NULL THEN
    SELECT p.role, p.full_name INTO v_role, v_name
      FROM public.profiles p WHERE p.id = v_actor;
  END IF;

  v_dedupe := NEW.id::text || ':' || v_new_status;

  INSERT INTO public.phoenix_movement_events (
    organization_id, trace_id, event_type, occurred_at,
    actor_id, actor_role, actor_name,
    source_label, destination_label,
    status_after, reference_type, reference_id, notes, dedupe_key
  )
  VALUES (
    v_home_org,
    NEW.id,
    TG_TABLE_NAME || '.' || v_new_status,
    now(),
    v_actor, v_role, v_name,
    (SELECT o.name FROM public.organizations o WHERE o.id = v_src_org),
    (SELECT o.name FROM public.organizations o WHERE o.id = v_dst_org),
    v_new_status,
    TG_TABLE_NAME,
    NEW.id,
    v_doc,
    v_dedupe
  )
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  -- 094: the same real transition also posts to the org-scoped notification
  -- feed. Same dedupe_key text as the ledger row above (separate unique
  -- index, separate table) — a lost-response retry of the underlying RPC
  -- cannot double-notify either.
  INSERT INTO public.phoenix_notifications (
    organization_id, event_type, occurred_at,
    actor_id, actor_role, actor_name,
    status_after, reference_type, reference_id, reference_label, dedupe_key
  )
  VALUES (
    v_home_org,
    TG_TABLE_NAME || '.' || v_new_status,
    now(),
    v_actor, v_role, v_name,
    v_new_status,
    TG_TABLE_NAME,
    NEW.id,
    v_doc,
    v_dedupe
  )
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$capture$;

COMMENT ON FUNCTION public.phoenix_capture_lifecycle_event() IS
  'AFTER INSERT/UPDATE capture of corridor header status transitions into '
  'phoenix_movement_events AND phoenix_notifications (094). SECURITY DEFINER '
  'so only the trigger path can append either. Idempotent via a shared '
  'dedupe_key text per (header, status), enforced by two separate unique '
  'indexes. TG_ARGV[0] = the initiating-org column that owns both rows for RLS.';

REVOKE ALL ON FUNCTION public.phoenix_capture_lifecycle_event() FROM PUBLIC;

-- No new triggers: the six existing `phoenix_capture_lifecycle` triggers
-- (attached in 082) already call this function by name and now emit
-- notifications for free.

-- ── D. Read RPCs ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_notifications_list(
  p_limit       integer DEFAULT 30,
  p_before_at   timestamptz DEFAULT NULL,
  p_before_id   uuid DEFAULT NULL,
  p_unread_only boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $list$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_role  text;
  v_limit integer;
  v_rows  jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);

  SELECT p.organization_id, p.role INTO v_org, v_role
    FROM public.profiles p
   WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'notifications', '[]'::jsonb, 'next_cursor', NULL);
  END IF;

  WITH scoped AS (
    SELECT n.*, (r.notification_id IS NOT NULL) AS is_read
      FROM public.phoenix_notifications n
      LEFT JOIN public.phoenix_notification_reads r
        ON r.notification_id = n.id AND r.profile_id = v_actor
     WHERE (v_role = 'super_admin' OR n.organization_id = v_org)
       AND (p_before_at IS NULL OR (n.occurred_at, n.id) < (p_before_at, p_before_id))
       AND (NOT p_unread_only OR r.notification_id IS NULL)
     ORDER BY n.occurred_at DESC, n.id DESC
     LIMIT v_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id',              s.id,
           'event_type',      s.event_type,
           'occurred_at',     s.occurred_at,
           'actor_id',        s.actor_id,
           'actor_role',      s.actor_role,
           'actor_name',      s.actor_name,
           'status',          s.status_after,
           'reference_type',  s.reference_type,
           'reference_id',    s.reference_id,
           'reference',       s.reference_label,
           'is_read',         s.is_read
         ) ORDER BY s.occurred_at DESC, s.id DESC), '[]'::jsonb)
    INTO v_rows
    FROM scoped s;

  RETURN jsonb_build_object(
    'ok', true,
    'notifications', v_rows,
    'next_cursor',
      CASE WHEN jsonb_array_length(v_rows) = v_limit
        THEN jsonb_build_object(
               'before_at', v_rows -> (v_limit - 1) -> 'occurred_at',
               'before_id', v_rows -> (v_limit - 1) -> 'id')
        ELSE NULL END
  );
END;
$list$;

REVOKE ALL ON FUNCTION public.phoenix_notifications_list(integer, timestamptz, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_notifications_list(integer, timestamptz, uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_notifications_unread_count()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $count$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_role  text;
  v_count integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT p.organization_id, p.role INTO v_org, v_role
    FROM public.profiles p
   WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.phoenix_notifications n
    LEFT JOIN public.phoenix_notification_reads r
      ON r.notification_id = n.id AND r.profile_id = v_actor
   WHERE (v_role = 'super_admin' OR n.organization_id = v_org)
     AND r.notification_id IS NULL;

  RETURN v_count;
END;
$count$;

REVOKE ALL ON FUNCTION public.phoenix_notifications_unread_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_notifications_unread_count() TO authenticated;

-- ── E. Write RPCs — the ONLY way phoenix_notification_reads is ever written ─

CREATE OR REPLACE FUNCTION public.phoenix_notifications_mark_read(
  p_notification_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $mark_read$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_role  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_notification_id IS NULL THEN
    RAISE EXCEPTION 'notification_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT p.organization_id, p.role INTO v_org, v_role
    FROM public.profiles p
   WHERE p.id = v_actor AND p.status = 'active';

  -- Deliberately no existence/forbidden distinction: an invisible or unknown
  -- id simply inserts zero rows. Matches phoenix_movement_timeline's rule
  -- that unauthorized and nonexistent must be indistinguishable.
  INSERT INTO public.phoenix_notification_reads (notification_id, profile_id)
  SELECT n.id, v_actor
    FROM public.phoenix_notifications n
   WHERE n.id = p_notification_id
     AND (v_role = 'super_admin' OR n.organization_id = v_org)
  ON CONFLICT (notification_id, profile_id) DO NOTHING;

  RETURN jsonb_build_object('ok', true);
END;
$mark_read$;

REVOKE ALL ON FUNCTION public.phoenix_notifications_mark_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_notifications_mark_read(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_notifications_mark_all_read()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $mark_all$
DECLARE
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_role   text;
  v_marked integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT p.organization_id, p.role INTO v_org, v_role
    FROM public.profiles p
   WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'marked', 0);
  END IF;

  WITH ins AS (
    INSERT INTO public.phoenix_notification_reads (notification_id, profile_id)
    SELECT n.id, v_actor
      FROM public.phoenix_notifications n
      LEFT JOIN public.phoenix_notification_reads r
        ON r.notification_id = n.id AND r.profile_id = v_actor
     WHERE (v_role = 'super_admin' OR n.organization_id = v_org)
       AND r.notification_id IS NULL
    ON CONFLICT (notification_id, profile_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_marked FROM ins;

  RETURN jsonb_build_object('ok', true, 'marked', v_marked);
END;
$mark_all$;

REVOKE ALL ON FUNCTION public.phoenix_notifications_mark_all_read() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_notifications_mark_all_read() TO authenticated;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS — run AFTER apply. Every one must hold. Read-only.
-- ============================================================================
--
-- 1. Both tables exist, RLS enabled:
--    SELECT relname, relrowsecurity FROM pg_class
--     WHERE relname IN ('phoenix_notifications','phoenix_notification_reads');
--    -- expect relrowsecurity = t for both.
--
-- 2. authenticated has SELECT-only on notifications, NOTHING on reads:
--    SELECT table_name, privilege_type FROM information_schema.role_table_grants
--     WHERE grantee='authenticated'
--       AND table_name IN ('phoenix_notifications','phoenix_notification_reads');
--    -- expect exactly one row: phoenix_notifications | SELECT
--
-- 3. dedupe uniqueness on notifications:
--    SELECT indexname FROM pg_indexes WHERE tablename='phoenix_notifications'
--     AND indexname='phoenix_notifications_dedupe_uniq';
--
-- 4. The capture function still resolves to exactly one overload and remains
--    SECURITY DEFINER with search_path pinned:
--    SELECT prosecdef, proconfig FROM pg_proc WHERE proname='phoenix_capture_lifecycle_event';
--    -- expect prosecdef=t, {search_path=public, pg_temp}
--
-- 5. All four new RPCs exist exactly once, SECURITY DEFINER, pinned search_path:
--    SELECT proname, count(*) FROM pg_proc
--     WHERE proname LIKE 'phoenix_notifications_%' GROUP BY proname;
--    -- expect 4 rows, count=1 each
--
-- 6. RECONCILIATION — this migration changes zero existing rows. Run BEFORE
--    and AFTER; both must return identical numbers for every pre-existing
--    table (warehouse_stock, outlet_stock, phoenix_movement_events, ...).
--
-- ============================================================================
-- ROLLBACK / CONTAINMENT
-- ============================================================================
--
-- CONTAINMENT (preferred, no schema change): stop calling the four new RPCs
-- from the frontend. The trigger keeps writing notification rows (harmless,
-- append-only, RLS-scoped) but nothing surfaces them.
--
-- FULL ROLLBACK:
--
--    BEGIN;
--      DROP FUNCTION IF EXISTS public.phoenix_notifications_mark_all_read();
--      DROP FUNCTION IF EXISTS public.phoenix_notifications_mark_read(uuid);
--      DROP FUNCTION IF EXISTS public.phoenix_notifications_unread_count();
--      DROP FUNCTION IF EXISTS public.phoenix_notifications_list(integer, timestamptz, uuid, boolean);
--      -- Revert the trigger function to 082's body (drop the notifications
--      -- INSERT block only; the movement_events INSERT must stay).
--      DROP TABLE IF EXISTS public.phoenix_notification_reads;
--      DROP TABLE IF EXISTS public.phoenix_notifications;
--    COMMIT;
--
-- Dropping both tables discards only notification state — no ledger row, no
-- movement row and no corridor header depends on them.
--
-- ============================================================================
-- FOLLOW-UP (NOT part of this migration — remaining Phase 2 contract items)
-- ============================================================================
-- * Wire local procurement (087), quarantine disposition changes, and the
--   monthly status center (092) into the same notification feed.
-- * Returns capped by received - dispensed - reserved - previously_returned.
-- * "Receive all counted matching lines" bulk receipt action.
-- * FEFO reasoned override parameter on phoenix_inventory_fefo_pick (072).
-- * Second-person approval gate for large/sensitive stock corrections.
-- ============================================================================
