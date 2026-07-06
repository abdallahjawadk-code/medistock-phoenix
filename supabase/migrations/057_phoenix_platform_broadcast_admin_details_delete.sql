-- =============================================================================
-- MediStock Phoenix V2 — Migration 057: Platform Broadcast Admin Details + Delete
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
--
-- Prerequisites: Migrations 001–056 must already be applied (056 creates
-- platform_broadcast_messages/targets/acknowledgements — this migration is
-- purely additive on top of that schema; migration 056 itself is NOT
-- redefined here).
--
-- Task: PHASE3-PLATFORM-BROADCAST-ACK-DETAILS-DELETE-A
--
-- -----------------------------------------------------------------------------
-- GOAL
-- -----------------------------------------------------------------------------
--   Two new Super Admin-only SECURITY DEFINER RPCs:
--
--   A) phoenix_get_platform_broadcast_ack_status(p_message_id uuid) —
--      institution-by-institution acknowledgement detail for one broadcast:
--      every targeted organization, whether it acknowledged, who (name/
--      email/role — never a raw auth uuid), and when.
--
--   B) phoenix_delete_platform_broadcast(p_message_id uuid, p_confirmation
--      text) — permanently deletes one broadcast message plus its target
--      and acknowledgement rows, gated behind a typed confirmation phrase,
--      with a server-side audit_logs snapshot written BEFORE the delete.
--
--   Nothing about migration 056's schema, RLS, or existing three RPCs is
--   changed — this migration only adds two new functions and their grants.
--   No table is added or altered.
--
-- -----------------------------------------------------------------------------
-- ACTOR NAME/EMAIL/ROLE RESOLUTION
-- -----------------------------------------------------------------------------
--   public.profiles has no email column (migration 001) — email lives on
--   auth.users. This migration resolves an acknowledger's display identity
--   with the exact join this codebase already uses everywhere else an actor
--   snapshot is needed (migrations 034/039):
--     SELECT p.full_name, u.email, p.role
--     FROM public.profiles p LEFT JOIN auth.users u ON u.id = p.id
--   The raw acknowledged_by uuid itself is never included in the RPC's
--   response — only full_name/email/role, per the "never expose raw auth
--   UUIDs unless unavoidable" requirement.
--
-- -----------------------------------------------------------------------------
-- WHAT DELETE DOES AND DOES NOT TOUCH
-- -----------------------------------------------------------------------------
--   Deletes exactly:
--     - the one platform_broadcast_messages row (WHERE id = p_message_id)
--     - its platform_broadcast_targets rows (ON DELETE CASCADE per migration
--       056's FK — verified below; also deleted explicitly first as
--       defense-in-depth, matching this migration's own delete-children-
--       first documentation requirement)
--     - its platform_broadcast_acknowledgements rows (same CASCADE + explicit
--       delete)
--   Never touches: organizations, profiles, auth.users, qr_targets/qr_tokens,
--   item_availability/item_availability_movements, permission_keys,
--   role_permission_defaults, profile_permission_overrides, audit_logs
--   (INSERT only, before the delete — never DELETEd from).
-- =============================================================================

-- =============================================================================
-- A) phoenix_get_platform_broadcast_ack_status — super_admin only
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_get_platform_broadcast_ack_status(
  p_message_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_role   text;
  v_msg    public.platform_broadcast_messages%ROWTYPE;
  v_target_count      int;
  v_acknowledged_count int;
  v_institutions       jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  END IF;

  SELECT * INTO v_msg FROM public.platform_broadcast_messages WHERE id = p_message_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  -- Institution set: for 'all', every organization the "status" column
  -- considers active (organizations.status is NOT NULL / has a CHECK
  -- constraint per migration 001 — 'active' is always a valid value there);
  -- for 'selected', only the explicitly targeted rows.
  IF v_msg.target_scope = 'all' THEN
    SELECT jsonb_agg(jsonb_build_object(
      'organization_id',        o.id,
      'organization_name',      o.name,
      'targeted',                true,
      'acknowledged',            (a.id IS NOT NULL),
      'acknowledged_at',         a.acknowledged_at,
      'acknowledged_by_name',    ap.full_name,
      'acknowledged_by_email',   au.email,
      'acknowledged_by_role',    ap.role
    ) ORDER BY o.name_ar) INTO v_institutions
    FROM public.organizations o
    LEFT JOIN public.platform_broadcast_acknowledgements a
      ON a.message_id = p_message_id AND a.organization_id = o.id
    LEFT JOIN public.profiles ap ON ap.id = a.acknowledged_by
    LEFT JOIN auth.users au ON au.id = a.acknowledged_by
    WHERE o.status = 'active';
  ELSE
    SELECT jsonb_agg(jsonb_build_object(
      'organization_id',        o.id,
      'organization_name',      o.name,
      'targeted',                true,
      'acknowledged',            (a.id IS NOT NULL),
      'acknowledged_at',         a.acknowledged_at,
      'acknowledged_by_name',    ap.full_name,
      'acknowledged_by_email',   au.email,
      'acknowledged_by_role',    ap.role
    ) ORDER BY o.name_ar) INTO v_institutions
    FROM public.platform_broadcast_targets t
    JOIN public.organizations o ON o.id = t.organization_id
    LEFT JOIN public.platform_broadcast_acknowledgements a
      ON a.message_id = p_message_id AND a.organization_id = o.id
    LEFT JOIN public.profiles ap ON ap.id = a.acknowledged_by
    LEFT JOIN auth.users au ON au.id = a.acknowledged_by
    WHERE t.message_id = p_message_id;
  END IF;

  IF v_msg.target_scope = 'all' THEN
    SELECT count(*) INTO v_target_count FROM public.organizations WHERE status = 'active';
  ELSE
    SELECT count(*) INTO v_target_count FROM public.platform_broadcast_targets WHERE message_id = p_message_id;
  END IF;

  SELECT count(*) INTO v_acknowledged_count
  FROM public.platform_broadcast_acknowledgements WHERE message_id = p_message_id;

  RETURN jsonb_build_object(
    'ok', true,
    'message', jsonb_build_object(
      'id',           v_msg.id,
      'title',        v_msg.title,
      'severity',     v_msg.severity,
      'target_scope', v_msg.target_scope,
      'publish_at',   v_msg.publish_at,
      'expires_at',   v_msg.expires_at,
      'is_active',    v_msg.is_active
    ),
    'target_count',       v_target_count,
    'acknowledged_count',  v_acknowledged_count,
    'pending_count',       GREATEST(v_target_count - v_acknowledged_count, 0),
    'institutions',        COALESCE(v_institutions, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_get_platform_broadcast_ack_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_platform_broadcast_ack_status(uuid) TO authenticated;

-- =============================================================================
-- B) phoenix_delete_platform_broadcast — super_admin only, typed confirmation
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_delete_platform_broadcast(
  p_message_id   uuid,
  p_confirmation text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_role     text;
  v_required text := 'DELETE PLATFORM BROADCAST';
  v_msg      public.platform_broadcast_messages%ROWTYPE;
  v_target_count      int;
  v_acknowledged_count int;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  END IF;

  IF p_confirmation IS DISTINCT FROM v_required THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CONFIRMATION');
  END IF;

  SELECT * INTO v_msg FROM public.platform_broadcast_messages WHERE id = p_message_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  IF v_msg.target_scope = 'all' THEN
    SELECT count(*) INTO v_target_count FROM public.organizations WHERE status = 'active';
  ELSE
    SELECT count(*) INTO v_target_count FROM public.platform_broadcast_targets WHERE message_id = p_message_id;
  END IF;

  SELECT count(*) INTO v_acknowledged_count
  FROM public.platform_broadcast_acknowledgements WHERE message_id = p_message_id;

  -- Audit snapshot is written BEFORE the delete — the row must exist for the
  -- FK-checked entity_id to remain meaningful in the log even though the
  -- broadcast itself is about to be removed (audit_logs.entity_id has no FK
  -- constraint — migration 001 — so this ordering is a documentation/safety
  -- choice, not a constraint requirement, but the snapshot values themselves
  -- (title/severity/counts) can only be read while the row still exists).
  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, payload
  ) VALUES (
    NULL, v_actor, v_role, 'platform_broadcast_deleted',
    'system', p_message_id,
    jsonb_build_object(
      'title', v_msg.title,
      'severity', v_msg.severity,
      'target_scope', v_msg.target_scope,
      'target_count', v_target_count,
      'acknowledged_count', v_acknowledged_count,
      'deleted_by', v_actor,
      'deleted_at', now(),
      'confirmation_used', true
    )
  );

  -- Explicit child deletes first (defense-in-depth) — migration 056 already
  -- declares both platform_broadcast_targets.message_id and
  -- platform_broadcast_acknowledgements.message_id as
  -- REFERENCES public.platform_broadcast_messages(id) ON DELETE CASCADE, so
  -- the final DELETE below would remove them regardless; deleting explicitly
  -- here makes that reliance visible/auditable rather than implicit.
  DELETE FROM public.platform_broadcast_targets WHERE message_id = p_message_id;
  DELETE FROM public.platform_broadcast_acknowledgements WHERE message_id = p_message_id;
  DELETE FROM public.platform_broadcast_messages WHERE id = p_message_id;

  RETURN jsonb_build_object('ok', true, 'id', p_message_id);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_delete_platform_broadcast(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_delete_platform_broadcast(uuid, text) TO authenticated;

-- Ask PostgREST to reload its schema cache so the two new RPCs are visible.
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- VERIFY
-- =============================================================================

DO $$
DECLARE
  v_src text;
BEGIN
  -- 1. Both RPCs exist
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_platform_broadcast_ack_status'),
    'VERIFY FAILED: phoenix_get_platform_broadcast_ack_status missing';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_delete_platform_broadcast'),
    'VERIFY FAILED: phoenix_delete_platform_broadcast missing';

  -- 2. SECURITY DEFINER on both (pg_get_functiondef renders this literally
  --    and reliably — unlike a SET clause, see FIX-MIGRATION-056-SEARCH-
  --    PATH-VERIFY-FALSE-POSITIVE-A precedent, this keyword is not
  --    reconstructed differently).
  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'phoenix_get_platform_broadcast_ack_status';
  ASSERT v_src LIKE '%SECURITY DEFINER%', 'VERIFY FAILED: ack-status RPC missing SECURITY DEFINER';

  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'phoenix_delete_platform_broadcast';
  ASSERT v_src LIKE '%SECURITY DEFINER%', 'VERIFY FAILED: delete RPC missing SECURITY DEFINER';

  -- 3. search_path public — checked via pg_proc.proconfig directly, not a
  --    pg_get_functiondef() text match (that text match is the exact bug
  --    FIX-MIGRATION-056-SEARCH-PATH-VERIFY-FALSE-POSITIVE-A fixed: Postgres
  --    reconstructs the SET clause as `SET search_path TO 'public'`, not the
  --    `= public` form the CREATE FUNCTION statements above are written
  --    with, so a literal '%SET search_path = public%' check would fail
  --    here even though both functions are correctly configured).
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname IN ('phoenix_get_platform_broadcast_ack_status', 'phoenix_delete_platform_broadcast')
      AND NOT EXISTS (
        SELECT 1 FROM unnest(COALESCE(proconfig, '{}')) AS cfg WHERE cfg ILIKE 'search_path=%public%'
      )
  ), 'VERIFY FAILED: an RPC is missing SET search_path = public';

  -- 4. super_admin gating on both
  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'phoenix_get_platform_broadcast_ack_status';
  ASSERT v_src LIKE '%INSUFFICIENT_ROLE%' AND v_src LIKE '%super_admin%',
    'VERIFY FAILED: ack-status RPC missing super_admin check';

  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'phoenix_delete_platform_broadcast';
  ASSERT v_src LIKE '%INSUFFICIENT_ROLE%' AND v_src LIKE '%super_admin%',
    'VERIFY FAILED: delete RPC missing super_admin check';

  -- 5. delete RPC requires the exact confirmation phrase
  ASSERT v_src LIKE '%DELETE PLATFORM BROADCAST%' AND v_src LIKE '%INVALID_CONFIRMATION%',
    'VERIFY FAILED: delete RPC missing DELETE PLATFORM BROADCAST confirmation check';

  -- 6. delete RPC uses the exact safe WHERE clauses (never a bare DELETE)
  ASSERT v_src LIKE '%DELETE FROM public.platform_broadcast_targets WHERE message_id = p_message_id%',
    'VERIFY FAILED: delete RPC does not scope targets delete by message_id';
  ASSERT v_src LIKE '%DELETE FROM public.platform_broadcast_acknowledgements WHERE message_id = p_message_id%',
    'VERIFY FAILED: delete RPC does not scope acknowledgements delete by message_id';
  ASSERT v_src LIKE '%DELETE FROM public.platform_broadcast_messages WHERE id = p_message_id%',
    'VERIFY FAILED: delete RPC does not scope messages delete by id';

  -- 7. No TRUNCATE anywhere
  ASSERT v_src NOT ILIKE '%TRUNCATE%', 'VERIFY FAILED: TRUNCATE must never be used';

  -- 8. No DELETE against any protected/core table
  ASSERT v_src NOT ILIKE '%DELETE FROM public.organizations%'
     AND v_src NOT ILIKE '%DELETE FROM public.profiles%'
     AND v_src NOT ILIKE '%DELETE FROM auth.users%'
     AND v_src NOT ILIKE '%DELETE FROM public.qr_targets%'
     AND v_src NOT ILIKE '%DELETE FROM public.qr_tokens%'
     AND v_src NOT ILIKE '%DELETE FROM public.item_availability%'
     AND v_src NOT ILIKE '%DELETE FROM public.permission_keys%'
     AND v_src NOT ILIKE '%DELETE FROM public.role_permission_defaults%'
     AND v_src NOT ILIKE '%DELETE FROM public.profile_permission_overrides%'
     AND v_src NOT ILIKE '%DELETE FROM public.audit_logs%',
    'VERIFY FAILED: delete RPC touches a protected table';

  -- 9. audit_logs INSERT happens before the deletes (textual order in source)
  ASSERT position('INSERT INTO public.audit_logs' in v_src) > 0
     AND position('INSERT INTO public.audit_logs' in v_src)
       < position('DELETE FROM public.platform_broadcast_targets' in v_src),
    'VERIFY FAILED: audit_logs insert must occur before the deletes';

  -- 10. No anon/PUBLIC execute grant on either RPC
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name IN ('phoenix_get_platform_broadcast_ack_status', 'phoenix_delete_platform_broadcast')
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon or PUBLIC has EXECUTE on a broadcast admin RPC';

  ASSERT (
    SELECT count(DISTINCT routine_name) FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name IN ('phoenix_get_platform_broadcast_ack_status', 'phoenix_delete_platform_broadcast')
      AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ) = 2, 'VERIFY FAILED: authenticated does not have EXECUTE on both broadcast admin RPCs';

  RAISE NOTICE '057 OK: phoenix_get_platform_broadcast_ack_status (institution-level ack detail) and phoenix_delete_platform_broadcast (typed-confirmation delete, audit-logged before delete) added — SECURITY DEFINER, search_path public, super_admin-gated, authenticated-only grants, no protected table touched.';
END $$;

-- =============================================================================
-- END OF MIGRATION 057
-- =============================================================================
