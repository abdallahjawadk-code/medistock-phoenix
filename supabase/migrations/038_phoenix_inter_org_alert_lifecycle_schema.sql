-- =============================================================================
-- MediStock Phoenix V2 — Migration 038: Inter-Org Alert Lifecycle Schema
-- =============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard → SQL Editor after a verified backup.
--
-- Prerequisites: 001 (item_availability, organizations), 002 (phoenix_my_role/
-- phoenix_my_org, phoenix_set_updated_at), 010 (permission_keys,
-- role_permission_defaults, phoenix_profile_has_permission), 036/037
-- (phoenix_get_live_inter_institution_alerts + source/target
-- item_availability_id in its payload).
--
-- Task: ALERT-LIFECYCLE-SCHEMA-A
--
-- Purpose (schema/permissions/RLS ONLY — this migration deliberately does NOT
-- create any lifecycle RPC and does NOT touch any UI):
--   ALERT-LIFECYCLE-AUDIT-A designed a persisted lifecycle layer for live
--   inter-institution alerts (open/acknowledged/in_progress/resolved/
--   dismissed). This migration lays the storage foundation for that design:
--     1. inter_org_alert_states — current lifecycle state, one row per
--        distinct (source_item_availability_id, target_item_availability_id,
--        alert_type) triple, keyed by a deterministic alert_key that a future
--        RPC will compute as:
--          source_item_availability_id || ':' ||
--          target_item_availability_id || ':' || alert_type
--     2. inter_org_alert_events — an immutable, append-only event log
--        recording every lifecycle transition, mirroring the
--        item_availability_movements ledger pattern (migration 033).
--     3. Four new permission keys under the existing inter_institution_alerts.*
--        namespace (acknowledge/manage/resolve/dismiss), seeded into
--        role_permission_defaults per the approved matrix.
--     4. RLS + grants for both tables, following the exact SELECT-only,
--        org-scoped, permission-gated pattern already proven in migration 033
--        for item_availability_movements — no INSERT/UPDATE/DELETE grant or
--        policy for authenticated on either table; all future writes will go
--        through SECURITY DEFINER RPCs (not created in this migration).
--
-- What this migration does NOT do:
--   - Does NOT modify migrations 001-037 in any way.
--   - Does NOT modify phoenix_get_live_inter_institution_alerts (036/037).
--   - Does NOT create phoenix_update_inter_org_alert_state,
--     phoenix_reopen_inter_org_alert, or any other lifecycle RPC — that is a
--     future, separately reported phase.
--   - Does NOT wire InterInstitutionAlertsScreen or DashboardScreen to this
--     schema — no frontend changes at all in this migration.
--   - Does NOT touch get_public_qr_payload, qr_tokens, qr_targets, or any
--     other QR-related object.
--   - Does NOT touch phoenix_apply_availability_movement, phoenix_upsert_
--     availability, or item_availability_movements (quantity-movement
--     features untouched).
--   - Does NOT grant INSERT, UPDATE, or DELETE on either new table to anon or
--     authenticated.
--   - Does NOT introduce an alerts.inter_org.* permission namespace — the
--     four new keys extend the existing inter_institution_alerts.* prefix.
--   - Does NOT use service_role or any elevated/admin API key.
--   - Does NOT add Excel/XLSX import.
--   - Does NOT expose supply_type anywhere.
--
-- Direct-SELECT decision for inter_org_alert_events (reported per the task's
-- own instruction to choose the safest option and report it):
--   Chosen: NO direct SELECT policy on inter_org_alert_events in this phase.
--   Reason: item_availability_movements (migration 033) IS directly
--   selectable because its rows carry no more sensitivity than data already
--   visible elsewhere in the app to the same audience. inter_org_alert_events,
--   however, will carry actor_name_snapshot/actor_email_snapshot columns
--   (personal identifying info) on every lifecycle transition — broader than
--   what any current direct-SELECT ledger exposes. Until a future RPC can
--   apply a controlled projection/shape (e.g. omitting email for a
--   permission tier, as an audit-log accessor), the safer default is no
--   direct table-level SELECT access at all. authenticated is not granted
--   SELECT on inter_org_alert_events; a future RPC (e.g.
--   phoenix_get_alert_events(p_alert_key)) will read it via
--   SECURITY DEFINER once created, bypassing this restriction internally.
--   No RLS SELECT policy is created for inter_org_alert_events accordingly
--   (RLS is still enabled — enabling RLS with zero policies denies all rows
--   to every role except a SECURITY DEFINER function, which bypasses RLS).
--
-- Safety:
--   - Idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
--     INSERT ... ON CONFLICT, DROP POLICY IF EXISTS + CREATE POLICY. Safe to
--     re-run.
--   - RLS enabled on both tables; no write policy exists for any role at the
--     RLS layer, and no INSERT/UPDATE/DELETE grant is made at the table-
--     privilege layer either (defense in depth, same as migration 033).
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. Permission catalog — 4 new keys under inter_institution_alerts.*
-- =============================================================================

INSERT INTO permission_keys (key, module, action, label_en, label_ar, is_dangerous)
VALUES
  ('inter_institution_alerts.acknowledge', 'inter_institution_alerts', 'acknowledge', 'Acknowledge inter-institution alert', 'تأكيد الاطلاع على التنبيه بين المؤسسات', false),
  ('inter_institution_alerts.manage',      'inter_institution_alerts', 'manage',      'Manage inter-institution alert (start/reopen)', 'إدارة التنبيه بين المؤسسات (بدء/إعادة فتح)', false),
  ('inter_institution_alerts.resolve',     'inter_institution_alerts', 'resolve',     'Resolve inter-institution alert', 'إغلاق التنبيه بين المؤسسات', false),
  ('inter_institution_alerts.dismiss',     'inter_institution_alerts', 'dismiss',     'Dismiss inter-institution alert', 'تجاهل التنبيه بين المؤسسات', true)
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- 2. Seed role_permission_defaults per the approved matrix
-- =============================================================================
-- Existing inter_institution_alerts.view rows (migrations 010/012) are
-- untouched — this section only inserts rows for the 4 new keys.

INSERT INTO role_permission_defaults (role, permission_key, allowed) VALUES
  -- super_admin: all four
  ('super_admin',            'inter_institution_alerts.acknowledge', true),
  ('super_admin',            'inter_institution_alerts.manage',      true),
  ('super_admin',            'inter_institution_alerts.resolve',     true),
  ('super_admin',            'inter_institution_alerts.dismiss',     true),

  -- institution_admin: all four
  ('institution_admin',      'inter_institution_alerts.acknowledge', true),
  ('institution_admin',      'inter_institution_alerts.manage',      true),
  ('institution_admin',      'inter_institution_alerts.resolve',     true),
  ('institution_admin',      'inter_institution_alerts.dismiss',     true),

  -- hospital_admin (legacy): same as institution_admin
  ('hospital_admin',         'inter_institution_alerts.acknowledge', true),
  ('hospital_admin',         'inter_institution_alerts.manage',      true),
  ('hospital_admin',         'inter_institution_alerts.resolve',     true),
  ('hospital_admin',         'inter_institution_alerts.dismiss',     true),

  -- warehouse_manager: acknowledge/manage/resolve, NOT dismiss
  ('warehouse_manager',      'inter_institution_alerts.acknowledge', true),
  ('warehouse_manager',      'inter_institution_alerts.manage',      true),
  ('warehouse_manager',      'inter_institution_alerts.resolve',     true),
  ('warehouse_manager',      'inter_institution_alerts.dismiss',     false),

  -- warehouse_officer: acknowledge/manage/resolve, NOT dismiss
  ('warehouse_officer',      'inter_institution_alerts.acknowledge', true),
  ('warehouse_officer',      'inter_institution_alerts.manage',      true),
  ('warehouse_officer',      'inter_institution_alerts.resolve',     true),
  ('warehouse_officer',      'inter_institution_alerts.dismiss',     false),

  -- transfer_manager: acknowledge only
  ('transfer_manager',       'inter_institution_alerts.acknowledge', true),
  ('transfer_manager',       'inter_institution_alerts.manage',      false),
  ('transfer_manager',       'inter_institution_alerts.resolve',     false),
  ('transfer_manager',       'inter_institution_alerts.dismiss',     false),

  -- monthly_status_officer: acknowledge only
  ('monthly_status_officer', 'inter_institution_alerts.acknowledge', true),
  ('monthly_status_officer', 'inter_institution_alerts.manage',      false),
  ('monthly_status_officer', 'inter_institution_alerts.resolve',     false),
  ('monthly_status_officer', 'inter_institution_alerts.dismiss',     false),

  -- port_officer: acknowledge only
  ('port_officer',           'inter_institution_alerts.acknowledge', true),
  ('port_officer',           'inter_institution_alerts.manage',      false),
  ('port_officer',           'inter_institution_alerts.resolve',     false),
  ('port_officer',           'inter_institution_alerts.dismiss',     false),

  -- point_operator (legacy): acknowledge only
  ('point_operator',         'inter_institution_alerts.acknowledge', true),
  ('point_operator',         'inter_institution_alerts.manage',      false),
  ('point_operator',         'inter_institution_alerts.resolve',     false),
  ('point_operator',         'inter_institution_alerts.dismiss',     false),

  -- viewer: no lifecycle write permissions
  ('viewer',                 'inter_institution_alerts.acknowledge', false),
  ('viewer',                 'inter_institution_alerts.manage',      false),
  ('viewer',                 'inter_institution_alerts.resolve',     false),
  ('viewer',                 'inter_institution_alerts.dismiss',     false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = excluded.allowed;

-- =============================================================================
-- 3. inter_org_alert_states — current lifecycle state (one row per alert_key)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.inter_org_alert_states (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_key                    text NOT NULL UNIQUE,
  alert_type                   text NOT NULL
                                 CHECK (alert_type IN ('surplus_to_shortage', 'near_expiry_to_shortage')),

  source_item_availability_id  uuid NOT NULL REFERENCES public.item_availability(id) ON DELETE RESTRICT,
  target_item_availability_id  uuid NOT NULL REFERENCES public.item_availability(id) ON DELETE RESTRICT,
  source_organization_id       uuid NOT NULL REFERENCES public.organizations(id),
  target_organization_id       uuid NOT NULL REFERENCES public.organizations(id),

  -- Denormalized identity snapshot: item_availability's own identity fields
  -- are mutable, so a state row snapshots them at first-seen time to keep
  -- historical/display records accurate even if the parent row's
  -- scientific_name/concentration/dosage_form later change (same rationale
  -- as item_availability_movements, migration 033).
  scientific_name              text NOT NULL,
  concentration                text,
  dosage_form                  text,

  status                       text NOT NULL DEFAULT 'open'
                                 CHECK (status IN ('open', 'acknowledged', 'in_progress', 'resolved', 'dismissed')),
  severity_snapshot            text
                                 CHECK (severity_snapshot IS NULL OR severity_snapshot IN ('high', 'medium', 'low')),

  first_seen_at                timestamptz NOT NULL DEFAULT now(),
  last_seen_at                 timestamptz NOT NULL DEFAULT now(),

  acknowledged_at              timestamptz,
  acknowledged_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  in_progress_at               timestamptz,
  in_progress_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at                  timestamptz,
  resolved_by                   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  dismissed_at                  timestamptz,
  dismissed_by                  uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  reason                        text,
  notes                         text,

  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inter_org_alert_states_orgs_distinct_chk
    CHECK (source_organization_id <> target_organization_id),
  CONSTRAINT inter_org_alert_states_availability_distinct_chk
    CHECK (source_item_availability_id <> target_item_availability_id),
  -- dismissed requires a non-empty reason (mirrors the correction_reason_chk
  -- pattern in item_availability_movements, migration 033).
  CONSTRAINT inter_org_alert_states_dismiss_reason_chk
    CHECK (status <> 'dismissed' OR (reason IS NOT NULL AND btrim(reason) <> '')),
  -- resolved likewise requires a non-empty reason — cheap insurance against
  -- a silent, unexplained closure (ALERT-LIFECYCLE-AUDIT-A section N flagged
  -- this as needing owner confirmation; enforced here as the stricter
  -- default, consistent with the dismiss requirement above).
  CONSTRAINT inter_org_alert_states_resolve_reason_chk
    CHECK (status <> 'resolved' OR (reason IS NOT NULL AND btrim(reason) <> ''))
);

COMMENT ON TABLE public.inter_org_alert_states IS
  'Current lifecycle state for one live inter-institution alert, keyed by a '
  'deterministic alert_key (source_item_availability_id || '':'' || '
  'target_item_availability_id || '':'' || alert_type). Rows are inserted/'
  'updated ONLY by a future SECURITY DEFINER RPC (not yet created as of '
  'migration 038) — there is no direct client INSERT, UPDATE, or DELETE path, '
  'by design. This table never stores or modifies item_availability.quantity; '
  'it tracks human coordination state about an alert, not stock levels.';

COMMENT ON COLUMN public.inter_org_alert_states.alert_key IS
  'Deterministic key a future RPC computes as source_item_availability_id || '
  ''':'' || target_item_availability_id || '':'' || alert_type. Not generated '
  'by a trigger in this migration — enforced unique here, computed by the '
  'future write RPC.';

-- =============================================================================
-- 4. inter_org_alert_events — immutable, append-only event log
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.inter_org_alert_events (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_state_id         uuid NOT NULL REFERENCES public.inter_org_alert_states(id) ON DELETE RESTRICT,

  event_type             text NOT NULL
                           CHECK (event_type IN ('opened', 'acknowledged', 'in_progress', 'resolved', 'dismissed', 'reopened', 'seen')),

  actor_id               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_name_snapshot    text,
  actor_email_snapshot   text,
  actor_role_snapshot    text,

  from_status            text,
  to_status               text,

  reason                 text,
  notes                  text,

  created_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.inter_org_alert_events IS
  'Immutable event log recording every inter_org_alert_states lifecycle '
  'transition (opened/acknowledged/in_progress/resolved/dismissed/reopened/'
  'seen), mirroring the item_availability_movements ledger pattern (migration '
  '033). Rows are inserted ONLY by a future SECURITY DEFINER RPC (not yet '
  'created as of migration 038) — there is no direct client INSERT, UPDATE, '
  'or DELETE path, and (per the direct-SELECT decision documented in this '
  'migration''s header) no direct client SELECT path either. Event rows must '
  'never be edited or removed after creation.';

-- =============================================================================
-- 5. Indexes
-- =============================================================================

CREATE INDEX IF NOT EXISTS inter_org_alert_states_alert_key_idx
  ON public.inter_org_alert_states(alert_key);
CREATE INDEX IF NOT EXISTS inter_org_alert_states_status_idx
  ON public.inter_org_alert_states(status);
CREATE INDEX IF NOT EXISTS inter_org_alert_states_source_org_idx
  ON public.inter_org_alert_states(source_organization_id);
CREATE INDEX IF NOT EXISTS inter_org_alert_states_target_org_idx
  ON public.inter_org_alert_states(target_organization_id);
CREATE INDEX IF NOT EXISTS inter_org_alert_states_source_avail_idx
  ON public.inter_org_alert_states(source_item_availability_id);
CREATE INDEX IF NOT EXISTS inter_org_alert_states_target_avail_idx
  ON public.inter_org_alert_states(target_item_availability_id);
CREATE INDEX IF NOT EXISTS inter_org_alert_states_last_seen_idx
  ON public.inter_org_alert_states(last_seen_at DESC);

CREATE INDEX IF NOT EXISTS inter_org_alert_events_state_created_idx
  ON public.inter_org_alert_events(alert_state_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inter_org_alert_events_actor_created_idx
  ON public.inter_org_alert_events(actor_id, created_at DESC);

-- =============================================================================
-- 6. updated_at trigger for inter_org_alert_states (reuses the project's
--    standard phoenix_set_updated_at() function, migration 001).
-- =============================================================================

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.inter_org_alert_states
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- 7. RLS
-- =============================================================================

ALTER TABLE public.inter_org_alert_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inter_org_alert_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inter_org_alert_states_select_perm" ON public.inter_org_alert_states;

CREATE POLICY "inter_org_alert_states_select_perm" ON public.inter_org_alert_states
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      phoenix_profile_has_permission(auth.uid(), 'inter_institution_alerts.view')
      AND (
        source_organization_id = phoenix_my_org()
        OR target_organization_id = phoenix_my_org()
      )
    )
  );

-- No INSERT/UPDATE/DELETE policy on inter_org_alert_states — intentional.
-- All future writes go through a SECURITY DEFINER RPC (not yet created),
-- which bypasses RLS internally, same pattern as
-- phoenix_apply_availability_movement / item_availability_movements.

-- inter_org_alert_events: RLS enabled, but NO SELECT/INSERT/UPDATE/DELETE
-- policy is created for authenticated in this phase — see the direct-SELECT
-- decision documented in this migration's header. With RLS enabled and zero
-- policies, every role (including authenticated) sees zero rows via direct
-- table access; a future SECURITY DEFINER RPC will read/write it by
-- bypassing RLS internally.

-- =============================================================================
-- 8. Grants
-- =============================================================================

REVOKE ALL ON TABLE public.inter_org_alert_states FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.inter_org_alert_states TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.inter_org_alert_states FROM authenticated;

REVOKE ALL ON TABLE public.inter_org_alert_events FROM PUBLIC, anon;
-- No SELECT grant to authenticated either — see direct-SELECT decision above.
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.inter_org_alert_events FROM authenticated;

-- =============================================================================
-- VERIFY
-- =============================================================================

DO $$
DECLARE
  v_states_exists   boolean;
  v_events_exists   boolean;
  v_states_rls      boolean;
  v_events_rls      boolean;
  v_key_count       int;
  v_states_col_count int;
  v_events_col_count int;
  v_states_policy_count int;
  v_events_policy_count int;
  v_select_qual     text;
BEGIN
  -- A. Both tables exist
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'inter_org_alert_states'
  ) INTO v_states_exists;
  ASSERT v_states_exists, 'VERIFY FAILED: inter_org_alert_states table not found';

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'inter_org_alert_events'
  ) INTO v_events_exists;
  ASSERT v_events_exists, 'VERIFY FAILED: inter_org_alert_events table not found';

  -- B. RLS enabled on both
  SELECT relrowsecurity INTO v_states_rls
  FROM pg_class WHERE relname = 'inter_org_alert_states' AND relnamespace = 'public'::regnamespace;
  ASSERT v_states_rls, 'VERIFY FAILED: RLS not enabled on inter_org_alert_states';

  SELECT relrowsecurity INTO v_events_rls
  FROM pg_class WHERE relname = 'inter_org_alert_events' AND relnamespace = 'public'::regnamespace;
  ASSERT v_events_rls, 'VERIFY FAILED: RLS not enabled on inter_org_alert_events';

  -- C. Expected columns exist on inter_org_alert_states
  SELECT count(*) INTO v_states_col_count FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'inter_org_alert_states'
    AND column_name IN (
      'id','alert_key','alert_type','source_item_availability_id',
      'target_item_availability_id','source_organization_id','target_organization_id',
      'scientific_name','concentration','dosage_form','status','severity_snapshot',
      'first_seen_at','last_seen_at','acknowledged_at','acknowledged_by',
      'in_progress_at','in_progress_by','resolved_at','resolved_by',
      'dismissed_at','dismissed_by','reason','notes','created_at','updated_at'
    );
  ASSERT v_states_col_count = 26,
    format('VERIFY FAILED: expected 26 columns on inter_org_alert_states, found %s', v_states_col_count);

  -- D. Expected columns exist on inter_org_alert_events
  SELECT count(*) INTO v_events_col_count FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'inter_org_alert_events'
    AND column_name IN (
      'id','alert_state_id','event_type','actor_id','actor_name_snapshot',
      'actor_email_snapshot','actor_role_snapshot','from_status','to_status',
      'reason','notes','created_at'
    );
  ASSERT v_events_col_count = 12,
    format('VERIFY FAILED: expected 12 columns on inter_org_alert_events, found %s', v_events_col_count);

  -- E. status/event_type CHECK constraints exist
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.inter_org_alert_states'::regclass
      AND pg_get_constraintdef(oid) LIKE '%status = ANY%'
       OR pg_get_constraintdef(oid) LIKE '%status IN%'
  ) OR EXISTS (
    SELECT 1 FROM information_schema.check_constraints cc
    JOIN information_schema.constraint_column_usage ccu ON cc.constraint_name = ccu.constraint_name
    WHERE ccu.table_name = 'inter_org_alert_states' AND ccu.column_name = 'status'
  ), 'VERIFY FAILED: no status CHECK constraint found on inter_org_alert_states';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.check_constraints cc
    JOIN information_schema.constraint_column_usage ccu ON cc.constraint_name = ccu.constraint_name
    WHERE ccu.table_name = 'inter_org_alert_events' AND ccu.column_name = 'event_type'
  ), 'VERIFY FAILED: no event_type CHECK constraint found on inter_org_alert_events';

  -- F. 4 new permission keys exist
  SELECT count(*) INTO v_key_count FROM permission_keys
  WHERE key IN (
    'inter_institution_alerts.acknowledge', 'inter_institution_alerts.manage',
    'inter_institution_alerts.resolve', 'inter_institution_alerts.dismiss'
  );
  ASSERT v_key_count = 4,
    format('VERIFY FAILED: expected 4 new permission keys, found %s', v_key_count);

  -- G. No alerts.inter_org.* keys were introduced
  ASSERT NOT EXISTS (SELECT 1 FROM permission_keys WHERE key LIKE 'alerts.inter_org%'),
    'VERIFY FAILED: alerts.inter_org.* namespace must not be introduced';

  -- H. Role defaults spot-check
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'super_admin' AND permission_key = 'inter_institution_alerts.dismiss') = true,
    'VERIFY FAILED: super_admin should have inter_institution_alerts.dismiss = true';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'warehouse_officer' AND permission_key = 'inter_institution_alerts.dismiss') = false,
    'VERIFY FAILED: warehouse_officer should have inter_institution_alerts.dismiss = false';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'warehouse_officer' AND permission_key = 'inter_institution_alerts.resolve') = true,
    'VERIFY FAILED: warehouse_officer should have inter_institution_alerts.resolve = true';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'monthly_status_officer' AND permission_key = 'inter_institution_alerts.acknowledge') = true,
    'VERIFY FAILED: monthly_status_officer should have inter_institution_alerts.acknowledge = true';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'monthly_status_officer' AND permission_key = 'inter_institution_alerts.manage') = false,
    'VERIFY FAILED: monthly_status_officer should have inter_institution_alerts.manage = false';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'viewer' AND permission_key = 'inter_institution_alerts.acknowledge') = false,
    'VERIFY FAILED: viewer should have inter_institution_alerts.acknowledge = false';

  -- I. authenticated has no INSERT/UPDATE/DELETE grant on either table
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'inter_org_alert_states'
      AND grantee = 'authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE')
  ), 'VERIFY FAILED: authenticated must not have INSERT/UPDATE/DELETE on inter_org_alert_states';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'inter_org_alert_events'
      AND grantee = 'authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE')
  ), 'VERIFY FAILED: authenticated must not have INSERT/UPDATE/DELETE on inter_org_alert_events';

  -- J. authenticated has no SELECT grant on events (per the direct-SELECT decision)
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'inter_org_alert_events'
      AND grantee = 'authenticated' AND privilege_type = 'SELECT'
  ), 'VERIFY FAILED: authenticated must not have direct SELECT on inter_org_alert_events in this phase';

  -- K. authenticated DOES have SELECT on states
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'inter_org_alert_states'
      AND grantee = 'authenticated' AND privilege_type = 'SELECT'
  ), 'VERIFY FAILED: authenticated should have SELECT on inter_org_alert_states';

  -- L. anon/PUBLIC have zero privileges on both tables
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name IN ('inter_org_alert_states','inter_org_alert_events')
      AND grantee IN ('anon','PUBLIC')
  ), 'VERIFY FAILED: anon or PUBLIC has privileges on the new alert lifecycle tables';

  -- M. Exactly one SELECT policy on states, none on events
  SELECT count(*) INTO v_states_policy_count FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'inter_org_alert_states';
  ASSERT v_states_policy_count = 1,
    format('VERIFY FAILED: expected exactly 1 policy on inter_org_alert_states, found %s', v_states_policy_count);

  SELECT count(*) INTO v_events_policy_count FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'inter_org_alert_events';
  ASSERT v_events_policy_count = 0,
    format('VERIFY FAILED: expected 0 policies on inter_org_alert_events, found %s', v_events_policy_count);

  -- N. SELECT policy on states checks inter_institution_alerts.view + org scope
  SELECT qual INTO v_select_qual FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'inter_org_alert_states'
    AND policyname = 'inter_org_alert_states_select_perm';
  ASSERT v_select_qual IS NOT NULL, 'VERIFY FAILED: inter_org_alert_states_select_perm policy not found';
  ASSERT v_select_qual LIKE '%inter_institution_alerts.view%',
    'VERIFY FAILED: inter_org_alert_states_select_perm does not check inter_institution_alerts.view';
  ASSERT v_select_qual LIKE '%source_organization_id%' AND v_select_qual LIKE '%target_organization_id%',
    'VERIFY FAILED: inter_org_alert_states_select_perm does not scope by source/target org';

  -- O. No lifecycle RPC created in this migration
  ASSERT NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_update_inter_org_alert_state'),
    'VERIFY FAILED: phoenix_update_inter_org_alert_state must not exist yet (this migration is schema-only)';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_reopen_inter_org_alert'),
    'VERIFY FAILED: phoenix_reopen_inter_org_alert must not exist yet (this migration is schema-only)';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_live_inter_institution_alerts_with_state'),
    'VERIFY FAILED: phoenix_get_live_inter_institution_alerts_with_state must not exist yet (this migration is schema-only)';

  -- P. Untouched: existing RPCs still present
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_live_inter_institution_alerts'),
    'VERIFY FAILED: phoenix_get_live_inter_institution_alerts is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement'),
    'VERIFY FAILED: phoenix_apply_availability_movement is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_upsert_availability'),
    'VERIFY FAILED: phoenix_upsert_availability is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_public_qr_payload'),
    'VERIFY FAILED: get_public_qr_payload is missing (must not be touched)';

  RAISE NOTICE '038 OK: inter_org_alert_states + inter_org_alert_events created with RLS/grants matching the item_availability_movements pattern, 4 new inter_institution_alerts.* permission keys seeded, no lifecycle RPC created, no existing RPC modified.';
END $$;

COMMIT;

-- =============================================================================
-- END OF MIGRATION 038
--
-- Post-apply manual verification (run in Supabase SQL Editor):
--
-- 1. Confirm both tables and their policies:
--    SELECT tablename, policyname, cmd, roles FROM pg_policies
--    WHERE schemaname = 'public' AND tablename IN ('inter_org_alert_states','inter_org_alert_events');
--    -- expect exactly 1 row: inter_org_alert_states | inter_org_alert_states_select_perm | SELECT | {authenticated}
--    -- expect 0 rows for inter_org_alert_events
--
-- 2. Confirm the new permission keys and role defaults:
--    SELECT role, permission_key, allowed FROM role_permission_defaults
--    WHERE permission_key LIKE 'inter_institution_alerts.%'
--    ORDER BY permission_key, role;
--
-- 3. Confirm no direct write is possible on either table (expect permission
--    denied, not success) and no direct SELECT is possible on
--    inter_org_alert_events even for super_admin's own session role grant
--    (RLS/grants apply at the client role level, not per-user; a
--    SECURITY DEFINER RPC is required to read it, none exists yet).
--
-- 4. Confirm anon has zero privileges on both tables:
--    SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema = 'public'
--      AND table_name IN ('inter_org_alert_states','inter_org_alert_events')
--      AND grantee = 'anon';
--    -- expect: 0 rows
--
-- NEXT PHASE (not part of this migration): create the lifecycle RPCs
-- (phoenix_get_live_inter_institution_alerts_with_state,
-- phoenix_update_inter_org_alert_state, optionally
-- phoenix_reopen_inter_org_alert) per ALERT-LIFECYCLE-AUDIT-A's design, then
-- wire InterInstitutionAlertsScreen/DashboardScreen in a subsequent UI phase.
-- =============================================================================
