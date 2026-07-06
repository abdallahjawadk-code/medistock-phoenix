-- =============================================================================
-- MediStock Phoenix V2 — Migration 056: Platform Broadcast Notices
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
--
-- Prerequisites: Migrations 001–055 must already be applied.
--
-- Task: PHASE3-PLATFORM-BROADCAST-NOTICES-A
--
-- -----------------------------------------------------------------------------
-- GOAL
-- -----------------------------------------------------------------------------
--   A Super Admin-only "platform broadcast" feature: super_admin creates a
--   message targeted at all institutions or a selected subset; institution
--   users see it as a pending popup after login; acknowledgement is tracked
--   at the INSTITUTION level (one ack per organization, not per user) — once
--   any user at an institution acknowledges, it never pops up again for that
--   institution. Super Admin can see an acknowledged/target/pending count
--   summary per message.
--
--   Purely additive: three new tables, five new SECURITY DEFINER RPCs. No
--   existing table, function, policy, or grant is modified. Zero relation to
--   QR, item_availability, item_availability_movements, Deep Clean (055), the
--   permission-key matrix, alert lifecycle, dashboard RPCs, Reports, Status
--   Center exports, or WhatsApp — none of those are read or written anywhere
--   in this migration.
--
-- -----------------------------------------------------------------------------
-- SCHEMA
-- -----------------------------------------------------------------------------
--   platform_broadcast_messages       — one row per broadcast.
--   platform_broadcast_targets        — one row per (message, org) ONLY when
--                                        target_scope = 'selected'. An 'all'
--                                        message has zero target rows (no
--                                        45-row fan-out for the common case).
--   platform_broadcast_acknowledgements — one row per (message, org) once any
--                                        user at that org acknowledges.
--
-- -----------------------------------------------------------------------------
-- SECURITY MODEL
-- -----------------------------------------------------------------------------
--   RLS enabled on all three tables. No INSERT/UPDATE/DELETE policy for
--   `authenticated` on any of them — every write goes through one of the five
--   SECURITY DEFINER RPCs below, matching the inter_org_alert_states /
--   inter_org_exchange_requests convention (migrations 038/040): the DB
--   enforces "writes only via RPC" at the grant level, not just by omission
--   of a client code path.
--
--   SELECT policies are intentionally narrow (super_admin only, or the
--   caller's own org for acknowledgements) — institution users read pending
--   broadcasts exclusively through phoenix_get_pending_platform_broadcasts(),
--   which does the active/published/unexpired/targeted/not-yet-acked
--   filtering server-side in one auditable place, rather than trying to
--   express that whole predicate as an RLS USING clause.
--
--   No anon/PUBLIC grant anywhere — same as every other RPC in this project.
-- =============================================================================

-- =============================================================================
-- 1. platform_broadcast_messages
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.platform_broadcast_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  title         text NOT NULL,
  body          text NOT NULL,

  severity      text NOT NULL
                  CHECK (severity IN ('info', 'warning', 'important', 'urgent')),

  target_scope  text NOT NULL
                  CHECK (target_scope IN ('all', 'selected')),

  publish_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NULL,

  is_active     boolean NOT NULL DEFAULT true,

  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT platform_broadcast_messages_title_not_blank_chk
    CHECK (btrim(title) <> ''),
  CONSTRAINT platform_broadcast_messages_body_not_blank_chk
    CHECK (btrim(body) <> ''),
  CONSTRAINT platform_broadcast_messages_expires_after_publish_chk
    CHECK (expires_at IS NULL OR expires_at > publish_at)
);

COMMENT ON TABLE public.platform_broadcast_messages IS
  'Platform-wide broadcast notices created by super_admin, targeted at all '
  'or a selected subset of organizations. Rows are only ever inserted/updated '
  'via phoenix_create_platform_broadcast / phoenix_deactivate_platform_broadcast '
  '— there is no direct client INSERT/UPDATE/DELETE path.';

CREATE INDEX IF NOT EXISTS platform_broadcast_messages_pending_idx
  ON public.platform_broadcast_messages (is_active, publish_at, expires_at);

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.platform_broadcast_messages
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.platform_broadcast_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pbm_select_superadmin" ON public.platform_broadcast_messages
  FOR SELECT TO authenticated
  USING (phoenix_my_role() = 'super_admin');

REVOKE ALL ON TABLE public.platform_broadcast_messages FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.platform_broadcast_messages TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.platform_broadcast_messages FROM authenticated;

-- =============================================================================
-- 2. platform_broadcast_targets — populated only for target_scope = 'selected'
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.platform_broadcast_targets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid NOT NULL REFERENCES public.platform_broadcast_messages(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT platform_broadcast_targets_unique UNIQUE (message_id, organization_id)
);

COMMENT ON TABLE public.platform_broadcast_targets IS
  'Explicit per-organization targeting for a platform_broadcast_messages row '
  'whose target_scope = ''selected''. Empty for target_scope = ''all'' — no '
  'row is ever inserted here for an ''all'' broadcast, avoiding an '
  'organizations-count fan-out for the common case.';

CREATE INDEX IF NOT EXISTS platform_broadcast_targets_org_idx
  ON public.platform_broadcast_targets (organization_id);

ALTER TABLE public.platform_broadcast_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pbt_select_superadmin" ON public.platform_broadcast_targets
  FOR SELECT TO authenticated
  USING (phoenix_my_role() = 'super_admin');

REVOKE ALL ON TABLE public.platform_broadcast_targets FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.platform_broadcast_targets TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.platform_broadcast_targets FROM authenticated;

-- =============================================================================
-- 3. platform_broadcast_acknowledgements — institution-level ack (one per org)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.platform_broadcast_acknowledgements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id       uuid NOT NULL REFERENCES public.platform_broadcast_messages(id) ON DELETE CASCADE,
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  acknowledged_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT platform_broadcast_acknowledgements_unique UNIQUE (message_id, organization_id)
);

COMMENT ON TABLE public.platform_broadcast_acknowledgements IS
  'Institution-level acknowledgement of a platform_broadcast_messages row — '
  'one row per (message, organization), regardless of which user at that '
  'organization actually clicked Acknowledge. This table IS the audit trail '
  'for acknowledgement (no separate audit_logs row is written per ack — see '
  'phoenix_ack_platform_broadcast below).';

CREATE INDEX IF NOT EXISTS platform_broadcast_acks_org_idx
  ON public.platform_broadcast_acknowledgements (organization_id);

ALTER TABLE public.platform_broadcast_acknowledgements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pba_select_superadmin_or_own_org" ON public.platform_broadcast_acknowledgements
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR organization_id = phoenix_my_org()
  );

REVOKE ALL ON TABLE public.platform_broadcast_acknowledgements FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.platform_broadcast_acknowledgements TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.platform_broadcast_acknowledgements FROM authenticated;

-- =============================================================================
-- A) phoenix_create_platform_broadcast — super_admin only
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_create_platform_broadcast(
  p_title        text,
  p_body         text,
  p_severity     text,
  p_target_scope text,
  p_org_ids      uuid[]      DEFAULT NULL,
  p_publish_at   timestamptz DEFAULT now(),
  p_expires_at   timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_role     text;
  v_title    text := btrim(COALESCE(p_title, ''));
  v_body     text := btrim(COALESCE(p_body, ''));
  v_message_id uuid;
  v_org_id   uuid;
  v_target_count int := 0;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  END IF;

  IF v_title = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'TITLE_REQUIRED');
  END IF;

  IF v_body = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BODY_REQUIRED');
  END IF;

  IF p_severity IS NULL OR p_severity NOT IN ('info', 'warning', 'important', 'urgent') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_SEVERITY');
  END IF;

  IF p_target_scope IS NULL OR p_target_scope NOT IN ('all', 'selected') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_TARGET_SCOPE');
  END IF;

  IF p_target_scope = 'selected' AND (p_org_ids IS NULL OR array_length(p_org_ids, 1) IS NULL OR array_length(p_org_ids, 1) = 0) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ORG_IDS_REQUIRED');
  END IF;

  IF p_expires_at IS NOT NULL AND p_expires_at <= COALESCE(p_publish_at, now()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_EXPIRES_AT');
  END IF;

  INSERT INTO public.platform_broadcast_messages (
    title, body, severity, target_scope, publish_at, expires_at, created_by, updated_by
  ) VALUES (
    v_title, v_body, p_severity, p_target_scope,
    COALESCE(p_publish_at, now()), p_expires_at, v_actor, v_actor
  )
  RETURNING id INTO v_message_id;

  -- Only 'selected' broadcasts get explicit target rows. An 'all' broadcast
  -- has zero rows in platform_broadcast_targets by design (see table comment).
  IF p_target_scope = 'selected' THEN
    FOREACH v_org_id IN ARRAY p_org_ids LOOP
      INSERT INTO public.platform_broadcast_targets (message_id, organization_id)
      VALUES (v_message_id, v_org_id)
      ON CONFLICT (message_id, organization_id) DO NOTHING;
    END LOOP;

    SELECT count(*) INTO v_target_count
    FROM public.platform_broadcast_targets WHERE message_id = v_message_id;
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, payload
  ) VALUES (
    NULL, v_actor, v_role, 'platform_broadcast_created',
    'system', v_message_id,
    jsonb_build_object(
      'title', v_title, 'severity', p_severity, 'target_scope', p_target_scope,
      'target_count', v_target_count, 'publish_at', COALESCE(p_publish_at, now()),
      'expires_at', p_expires_at
    )
  );

  RETURN jsonb_build_object('ok', true, 'id', v_message_id);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_create_platform_broadcast(
  text, text, text, text, uuid[], timestamptz, timestamptz
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_create_platform_broadcast(
  text, text, text, text, uuid[], timestamptz, timestamptz
) TO authenticated;

-- =============================================================================
-- B) phoenix_deactivate_platform_broadcast — super_admin only
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_deactivate_platform_broadcast(
  p_message_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role  text;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  END IF;

  IF p_message_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_broadcast_messages WHERE id = p_message_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'MESSAGE_NOT_FOUND');
  END IF;

  UPDATE public.platform_broadcast_messages
     SET is_active  = false,
         updated_by = v_actor,
         updated_at = now()
   WHERE id = p_message_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, payload
  ) VALUES (
    NULL, v_actor, v_role, 'platform_broadcast_deactivated',
    'system', p_message_id, jsonb_build_object('message_id', p_message_id)
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_deactivate_platform_broadcast(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_deactivate_platform_broadcast(uuid) TO authenticated;

-- =============================================================================
-- C) phoenix_list_platform_broadcasts_admin — super_admin only
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_list_platform_broadcasts_admin()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role  text;
  v_active_org_count int;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  END IF;

  SELECT count(*) INTO v_active_org_count
  FROM public.organizations WHERE status = 'active';

  SELECT jsonb_agg(row_data ORDER BY (row_data->>'created_at') DESC) INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id',              m.id,
      'title',           m.title,
      'body',            m.body,
      'severity',        m.severity,
      'target_scope',    m.target_scope,
      'publish_at',      m.publish_at,
      'expires_at',      m.expires_at,
      'is_active',       m.is_active,
      'created_at',      m.created_at,
      'target_count',    CASE
                            WHEN m.target_scope = 'all' THEN v_active_org_count
                            ELSE (SELECT count(*) FROM public.platform_broadcast_targets t WHERE t.message_id = m.id)
                          END,
      'acknowledged_count', (SELECT count(*) FROM public.platform_broadcast_acknowledgements a WHERE a.message_id = m.id),
      'pending_count',   GREATEST(
                            (CASE
                               WHEN m.target_scope = 'all' THEN v_active_org_count
                               ELSE (SELECT count(*) FROM public.platform_broadcast_targets t WHERE t.message_id = m.id)
                             END)
                            - (SELECT count(*) FROM public.platform_broadcast_acknowledgements a WHERE a.message_id = m.id),
                            0
                          )
    ) AS row_data
    FROM public.platform_broadcast_messages m
  ) sub;

  RETURN jsonb_build_object('ok', true, 'messages', COALESCE(v_result, '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_list_platform_broadcasts_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_list_platform_broadcasts_admin() TO authenticated;

-- =============================================================================
-- D) phoenix_get_pending_platform_broadcasts — any authenticated user with an org
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_get_pending_platform_broadcasts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT organization_id INTO v_org FROM public.profiles WHERE id = v_actor;

  -- No organization (e.g. a super_admin with no fixed org, or an
  -- unattached profile) -> nothing pending, not an error.
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'broadcasts', '[]'::jsonb);
  END IF;

  SELECT jsonb_agg(row_data ORDER BY (row_data->>'publish_at') DESC) INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id',         m.id,
      'title',      m.title,
      'body',       m.body,
      'severity',   m.severity,
      'publish_at', m.publish_at,
      'expires_at', m.expires_at
    ) AS row_data
    FROM public.platform_broadcast_messages m
    WHERE m.is_active = true
      AND m.publish_at <= now()
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND (
        m.target_scope = 'all'
        OR EXISTS (
          SELECT 1 FROM public.platform_broadcast_targets t
          WHERE t.message_id = m.id AND t.organization_id = v_org
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.platform_broadcast_acknowledgements a
        WHERE a.message_id = m.id AND a.organization_id = v_org
      )
  ) sub;

  RETURN jsonb_build_object('ok', true, 'broadcasts', COALESCE(v_result, '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_get_pending_platform_broadcasts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_pending_platform_broadcasts() TO authenticated;

-- =============================================================================
-- E) phoenix_ack_platform_broadcast — any authenticated user with an org
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_ack_platform_broadcast(
  p_message_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_msg   public.platform_broadcast_messages%ROWTYPE;
  v_targeted boolean;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT organization_id INTO v_org FROM public.profiles WHERE id = v_actor;
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NO_ORGANIZATION');
  END IF;

  SELECT * INTO v_msg FROM public.platform_broadcast_messages WHERE id = p_message_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'MESSAGE_NOT_FOUND');
  END IF;

  -- The message must currently be visible/targeted to the caller's org —
  -- an org can only acknowledge a message it was actually shown.
  v_targeted := v_msg.is_active
    AND v_msg.publish_at <= now()
    AND (v_msg.expires_at IS NULL OR v_msg.expires_at > now())
    AND (
      v_msg.target_scope = 'all'
      OR EXISTS (
        SELECT 1 FROM public.platform_broadcast_targets t
        WHERE t.message_id = p_message_id AND t.organization_id = v_org
      )
    );

  IF NOT v_targeted THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_TARGETED');
  END IF;

  -- Institution-level acknowledgement: one row per (message, org). ON
  -- CONFLICT DO NOTHING makes this idempotent under a multi-tab/multi-user
  -- race — the first caller wins, every later caller still gets ok=true.
  -- No audit_logs row is written here by design: this table IS the audit
  -- trail for acknowledgement (see table comment above).
  INSERT INTO public.platform_broadcast_acknowledgements (
    message_id, organization_id, acknowledged_by
  ) VALUES (
    p_message_id, v_org, v_actor
  )
  ON CONFLICT (message_id, organization_id) DO NOTHING;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_ack_platform_broadcast(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_ack_platform_broadcast(uuid) TO authenticated;

-- Ask PostgREST to reload its schema cache so the new tables/RPCs are visible.
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- VERIFY
-- =============================================================================

DO $$
DECLARE
  v_src text;
BEGIN
  -- 1. Tables exist
  ASSERT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'platform_broadcast_messages'),
    'VERIFY FAILED: platform_broadcast_messages missing';
  ASSERT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'platform_broadcast_targets'),
    'VERIFY FAILED: platform_broadcast_targets missing';
  ASSERT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'platform_broadcast_acknowledgements'),
    'VERIFY FAILED: platform_broadcast_acknowledgements missing';

  -- 2. RLS enabled on all three
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.platform_broadcast_messages'::regclass),
    'VERIFY FAILED: RLS not enabled on platform_broadcast_messages';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.platform_broadcast_targets'::regclass),
    'VERIFY FAILED: RLS not enabled on platform_broadcast_targets';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.platform_broadcast_acknowledgements'::regclass),
    'VERIFY FAILED: RLS not enabled on platform_broadcast_acknowledgements';

  -- 3. Unique constraints
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.platform_broadcast_targets'::regclass
      AND conname = 'platform_broadcast_targets_unique' AND contype = 'u'
  ), 'VERIFY FAILED: platform_broadcast_targets unique(message_id, organization_id) missing';
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.platform_broadcast_acknowledgements'::regclass
      AND conname = 'platform_broadcast_acknowledgements_unique' AND contype = 'u'
  ), 'VERIFY FAILED: platform_broadcast_acknowledgements unique(message_id, organization_id) missing';

  -- 4. No write policy for authenticated on any of the three tables
  ASSERT (
    SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('platform_broadcast_messages', 'platform_broadcast_targets', 'platform_broadcast_acknowledgements')
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
  ) = 0, 'VERIFY FAILED: an INSERT/UPDATE/DELETE policy exists on a broadcast table — writes must be RPC-only';

  -- 5. RPCs exist, SECURITY DEFINER, search_path public
  FOR v_src IN
    SELECT pg_get_functiondef(oid) FROM pg_proc
    WHERE proname IN (
      'phoenix_create_platform_broadcast', 'phoenix_deactivate_platform_broadcast',
      'phoenix_list_platform_broadcasts_admin', 'phoenix_get_pending_platform_broadcasts',
      'phoenix_ack_platform_broadcast'
    )
  LOOP
    ASSERT v_src LIKE '%SECURITY DEFINER%', 'VERIFY FAILED: an RPC is missing SECURITY DEFINER';
    ASSERT v_src LIKE '%SET search_path = public%', 'VERIFY FAILED: an RPC is missing SET search_path = public';
  END LOOP;

  ASSERT (
    SELECT count(*) FROM pg_proc
    WHERE proname IN (
      'phoenix_create_platform_broadcast', 'phoenix_deactivate_platform_broadcast',
      'phoenix_list_platform_broadcasts_admin', 'phoenix_get_pending_platform_broadcasts',
      'phoenix_ack_platform_broadcast'
    )
  ) = 5, 'VERIFY FAILED: not all five RPCs exist';

  -- 6. super_admin checks in admin RPCs
  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'phoenix_create_platform_broadcast';
  ASSERT v_src LIKE '%INSUFFICIENT_ROLE%' AND v_src LIKE '%super_admin%',
    'VERIFY FAILED: phoenix_create_platform_broadcast missing super_admin check';

  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'phoenix_deactivate_platform_broadcast';
  ASSERT v_src LIKE '%INSUFFICIENT_ROLE%' AND v_src LIKE '%super_admin%',
    'VERIFY FAILED: phoenix_deactivate_platform_broadcast missing super_admin check';

  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'phoenix_list_platform_broadcasts_admin';
  ASSERT v_src LIKE '%INSUFFICIENT_ROLE%' AND v_src LIKE '%super_admin%',
    'VERIFY FAILED: phoenix_list_platform_broadcasts_admin missing super_admin check';

  -- 7. ack RPC uses ON CONFLICT DO NOTHING
  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'phoenix_ack_platform_broadcast';
  ASSERT v_src LIKE '%ON CONFLICT (message_id, organization_id) DO NOTHING%',
    'VERIFY FAILED: phoenix_ack_platform_broadcast missing ON CONFLICT DO NOTHING';
  ASSERT v_src NOT LIKE '%INSERT INTO public.audit_logs%',
    'VERIFY FAILED: phoenix_ack_platform_broadcast must not write an audit_logs row';

  -- 8. audit_logs INSERT present only in create/deactivate
  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'phoenix_create_platform_broadcast';
  ASSERT v_src LIKE '%INSERT INTO public.audit_logs%' AND v_src LIKE '%platform_broadcast_created%',
    'VERIFY FAILED: phoenix_create_platform_broadcast missing audit_logs insert';

  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'phoenix_deactivate_platform_broadcast';
  ASSERT v_src LIKE '%INSERT INTO public.audit_logs%' AND v_src LIKE '%platform_broadcast_deactivated%',
    'VERIFY FAILED: phoenix_deactivate_platform_broadcast missing audit_logs insert';

  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'phoenix_get_pending_platform_broadcasts';
  ASSERT v_src NOT LIKE '%INSERT INTO public.audit_logs%',
    'VERIFY FAILED: phoenix_get_pending_platform_broadcasts must not write audit_logs (read-only RPC)';

  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'phoenix_list_platform_broadcasts_admin';
  ASSERT v_src NOT LIKE '%INSERT INTO public.audit_logs%',
    'VERIFY FAILED: phoenix_list_platform_broadcasts_admin must not write audit_logs (read-only RPC)';

  -- 9. No anon/PUBLIC execute grant on any of the five RPCs
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'phoenix_create_platform_broadcast', 'phoenix_deactivate_platform_broadcast',
        'phoenix_list_platform_broadcasts_admin', 'phoenix_get_pending_platform_broadcasts',
        'phoenix_ack_platform_broadcast'
      )
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon or PUBLIC has EXECUTE on a platform broadcast RPC';

  ASSERT (
    SELECT count(DISTINCT routine_name) FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'phoenix_create_platform_broadcast', 'phoenix_deactivate_platform_broadcast',
        'phoenix_list_platform_broadcasts_admin', 'phoenix_get_pending_platform_broadcasts',
        'phoenix_ack_platform_broadcast'
      )
      AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ) = 5, 'VERIFY FAILED: authenticated does not have EXECUTE on all five platform broadcast RPCs';

  RAISE NOTICE '056 OK: three new broadcast tables created with RLS enabled and no authenticated write policies; five SECURITY DEFINER RPCs in place (super_admin-gated create/deactivate/list, org-scoped pending/ack); no anon/PUBLIC grants; fully additive, no prior migration or table modified.';
END $$;

-- =============================================================================
-- END OF MIGRATION 056
-- =============================================================================
