-- ============================================================================
-- MIGRATION 033 — Availability quantity movements: schema + permission matrix
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: 001, 002 (item_availability + RLS), 010 (permission matrix +
-- phoenix_profile_has_permission helper), 032 (availability.create/update
-- permission-matrix pattern this migration extends).
--
-- Task: AVAILABILITY-QUANTITY-MOVEMENT-DB-A
--
-- Purpose (schema/permissions ONLY — this migration deliberately does NOT
-- create the movement RPC or touch any UI):
--   Today, phoenix_upsert_availability (migration 032) overwrites
--   item_availability.quantity directly on every save — there is no record
--   of the previous value, no delta, and no reason. This migration lays the
--   foundation for an auditable quantity-movement feature by:
--     1. Adding 7 new permission keys for the 4 movement modes (set/add/
--        subtract/correct) plus view/export/print of movement history.
--     2. Seeding role_permission_defaults for those 7 keys per the approved
--        matrix.
--     3. Creating an immutable ledger table, item_availability_movements,
--        with SELECT-only RLS (no INSERT/UPDATE/DELETE policy for any role —
--        writes will only ever be possible through a future SECURITY
--        DEFINER RPC, not yet created).
--
-- What this migration does NOT do:
--   - Does NOT create phoenix_apply_availability_movement or any other RPC.
--   - Does NOT modify phoenix_upsert_availability in any way.
--   - Does NOT modify item_availability's own RLS policies (avail_select_org,
--     avail_select_anon, avail_insert_perm, avail_update_perm — migration 032
--     — are all left exactly as they are).
--   - Does NOT touch get_public_qr_payload, qr_tokens, qr_targets, or any
--     other QR-related object.
--   - Does NOT touch EditorScreen or StatusCenter — no frontend UI wiring.
--   - Does NOT grant INSERT, UPDATE, or DELETE on item_availability_movements
--     to anon or authenticated.
--   - Does NOT weaken any existing RLS policy anywhere.
--   - Does NOT drop, truncate, or delete any existing data.
--
-- Assigned-distribution-point scope note (consistent with migration 032):
--   port_officer/point_operator remain organization-scoped for movements,
--   same as their existing availability.update scope. No assigned_point_id
--   column or assignment table exists anywhere in the schema; inventing one
--   is out of scope here. When/if such a model is approved, a follow-up
--   migration should tighten the SELECT policy below (and the future RPC)
--   for these two roles specifically.
--
-- Safety:
--   - Idempotent: INSERT ... ON CONFLICT, CREATE TABLE IF NOT EXISTS,
--     DROP POLICY IF EXISTS + CREATE POLICY. Safe to re-run.
--   - RLS is enabled with SELECT-only access; no write policy exists for
--     any role at the RLS layer, and no INSERT/UPDATE/DELETE grant is made
--     at the table-privilege layer either (defense in depth — even a future
--     bug in RLS policy authoring could not allow a direct client write,
--     because the underlying GRANT is simply absent).
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Permission catalog — add the 7 quantity-movement permission keys
-- ============================================================================

INSERT INTO permission_keys (key, module, action, label_en, label_ar, is_dangerous)
VALUES
  ('availability.quantity.set',      'availability', 'quantity_set',      'Set exact quantity',            'تحديد الكمية بدقة',    false),
  ('availability.quantity.add',      'availability', 'quantity_add',      'Add to quantity',                'إضافة إلى الكمية',      false),
  ('availability.quantity.subtract', 'availability', 'quantity_subtract', 'Subtract from quantity',          'خصم من الكمية',         false),
  ('availability.quantity.correct',  'availability', 'quantity_correct',  'Correct quantity',                'تصحيح الكمية',          true),
  ('availability.movements.view',    'availability', 'movements_view',    'View quantity movement history',  'عرض سجل حركات الكمية',  false),
  ('availability.movements.export',  'availability', 'movements_export',  'Export quantity movements',       'تصدير حركات الكمية',    false),
  ('availability.movements.print',   'availability', 'movements_print',   'Print quantity movements',        'طباعة حركات الكمية',    false)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 2. Seed role_permission_defaults per the approved matrix
-- ============================================================================
-- availability.view/manage/create/update rows from migrations 010/012/032 are
-- untouched — this section only inserts rows for the 7 new keys.

INSERT INTO role_permission_defaults (role, permission_key, allowed) VALUES
  -- super_admin: all seven
  ('super_admin',             'availability.quantity.set',      true),
  ('super_admin',             'availability.quantity.add',      true),
  ('super_admin',             'availability.quantity.subtract', true),
  ('super_admin',             'availability.quantity.correct',  true),
  ('super_admin',             'availability.movements.view',    true),
  ('super_admin',             'availability.movements.export',  true),
  ('super_admin',             'availability.movements.print',   true),

  -- institution_admin: all seven
  ('institution_admin',       'availability.quantity.set',      true),
  ('institution_admin',       'availability.quantity.add',      true),
  ('institution_admin',       'availability.quantity.subtract', true),
  ('institution_admin',       'availability.quantity.correct',  true),
  ('institution_admin',       'availability.movements.view',    true),
  ('institution_admin',       'availability.movements.export',  true),
  ('institution_admin',       'availability.movements.print',   true),

  -- hospital_admin (legacy): same as institution_admin
  ('hospital_admin',          'availability.quantity.set',      true),
  ('hospital_admin',          'availability.quantity.add',      true),
  ('hospital_admin',          'availability.quantity.subtract', true),
  ('hospital_admin',          'availability.quantity.correct',  true),
  ('hospital_admin',          'availability.movements.view',    true),
  ('hospital_admin',          'availability.movements.export',  true),
  ('hospital_admin',          'availability.movements.print',   true),

  -- warehouse_officer: set/add/subtract + view/export/print, NOT correct
  ('warehouse_officer',       'availability.quantity.set',      true),
  ('warehouse_officer',       'availability.quantity.add',      true),
  ('warehouse_officer',       'availability.quantity.subtract', true),
  ('warehouse_officer',       'availability.quantity.correct',  false),
  ('warehouse_officer',       'availability.movements.view',    true),
  ('warehouse_officer',       'availability.movements.export',  true),
  ('warehouse_officer',       'availability.movements.print',   true),

  -- warehouse_manager (legacy): same as warehouse_officer
  ('warehouse_manager',       'availability.quantity.set',      true),
  ('warehouse_manager',       'availability.quantity.add',      true),
  ('warehouse_manager',       'availability.quantity.subtract', true),
  ('warehouse_manager',       'availability.quantity.correct',  false),
  ('warehouse_manager',       'availability.movements.view',    true),
  ('warehouse_manager',       'availability.movements.export',  true),
  ('warehouse_manager',       'availability.movements.print',   true),

  -- port_officer: add/subtract + view only, NOT set/correct/export/print
  ('port_officer',            'availability.quantity.set',      false),
  ('port_officer',            'availability.quantity.add',      true),
  ('port_officer',            'availability.quantity.subtract', true),
  ('port_officer',            'availability.quantity.correct',  false),
  ('port_officer',            'availability.movements.view',    true),
  ('port_officer',            'availability.movements.export',  false),
  ('port_officer',            'availability.movements.print',   false),

  -- point_operator (legacy): same as port_officer
  ('point_operator',          'availability.quantity.set',      false),
  ('point_operator',          'availability.quantity.add',      true),
  ('point_operator',          'availability.quantity.subtract', true),
  ('point_operator',          'availability.quantity.correct',  false),
  ('point_operator',          'availability.movements.view',    true),
  ('point_operator',          'availability.movements.export',  false),
  ('point_operator',          'availability.movements.print',   false),

  -- monthly_status_officer: view only
  ('monthly_status_officer',  'availability.quantity.set',      false),
  ('monthly_status_officer',  'availability.quantity.add',      false),
  ('monthly_status_officer',  'availability.quantity.subtract', false),
  ('monthly_status_officer',  'availability.quantity.correct',  false),
  ('monthly_status_officer',  'availability.movements.view',    true),
  ('monthly_status_officer',  'availability.movements.export',  false),
  ('monthly_status_officer',  'availability.movements.print',   false),

  -- transfer_manager (legacy): view only
  ('transfer_manager',        'availability.quantity.set',      false),
  ('transfer_manager',        'availability.quantity.add',      false),
  ('transfer_manager',        'availability.quantity.subtract', false),
  ('transfer_manager',        'availability.quantity.correct',  false),
  ('transfer_manager',        'availability.movements.view',    true),
  ('transfer_manager',        'availability.movements.export',  false),
  ('transfer_manager',        'availability.movements.print',   false),

  -- viewer: view only
  ('viewer',                  'availability.quantity.set',      false),
  ('viewer',                  'availability.quantity.add',      false),
  ('viewer',                  'availability.quantity.subtract', false),
  ('viewer',                  'availability.quantity.correct',  false),
  ('viewer',                  'availability.movements.view',    true),
  ('viewer',                  'availability.movements.export',  false),
  ('viewer',                  'availability.movements.print',   false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = excluded.allowed;

-- ============================================================================
-- 3. Create the immutable quantity-movement ledger table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.item_availability_movements (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_availability_id   uuid NOT NULL REFERENCES public.item_availability(id) ON DELETE RESTRICT,
  organization_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  distribution_point_id  uuid NOT NULL REFERENCES public.distribution_points(id) ON DELETE RESTRICT,

  -- Denormalized identity snapshot: item_availability's own identity fields
  -- are mutable (COALESCE-matched, migration 032), so a movement row snapshots
  -- them at the time of the movement to keep historical records accurate even
  -- if the parent row's scientific_name/concentration/dosage_form later change.
  scientific_name        text NOT NULL,
  concentration          text,
  dosage_form            text,
  trade_name             text,

  movement_type          text NOT NULL,
  quantity_before         integer NOT NULL,
  quantity_delta          integer NOT NULL,
  quantity_after          integer NOT NULL,

  reason                 text,
  notes                  text,

  created_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_name_snapshot    text,
  actor_email_snapshot   text,
  actor_role_snapshot    text,

  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT item_availability_movements_type_chk
    CHECK (movement_type IN ('set_exact', 'add', 'subtract', 'correction')),
  CONSTRAINT item_availability_movements_qty_before_chk
    CHECK (quantity_before >= 0),
  CONSTRAINT item_availability_movements_qty_after_chk
    CHECK (quantity_after >= 0),
  -- Corrections must be explained; add/subtract/set_exact are not required to
  -- carry a reason at the table level (the future RPC may still choose to
  -- require one for other modes — this is the minimum, non-negotiable floor).
  CONSTRAINT item_availability_movements_correction_reason_chk
    CHECK (movement_type <> 'correction' OR (reason IS NOT NULL AND btrim(reason) <> ''))
);

COMMENT ON TABLE public.item_availability_movements IS
  'Immutable quantity-movement ledger for item_availability. Every row records '
  'one quantity change (set_exact/add/subtract/correction) with before/after '
  'values, actor identity, and an optional reason/notes. Rows are inserted '
  'ONLY by a future SECURITY DEFINER RPC (phoenix_apply_availability_movement, '
  'not yet created as of migration 033) — there is no direct client INSERT, '
  'UPDATE, or DELETE path, by design. Movement rows must never be edited or '
  'removed after creation; corrections are recorded as new rows, never as '
  'edits to history. Scope is organization-level for all roles including '
  'port_officer/point_operator, consistent with migration 032 — no assigned '
  'distribution-point model exists yet in this schema.';

COMMENT ON COLUMN public.item_availability_movements.movement_type IS
  'One of: set_exact (replace quantity), add (increase), subtract (decrease), '
  'correction (explicit fix, requires a non-empty reason).';

COMMENT ON COLUMN public.item_availability_movements.quantity_delta IS
  'Signed change applied: quantity_after - quantity_before. Positive for add, '
  'negative for subtract, either sign for set_exact/correction.';

-- ============================================================================
-- 4. Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS item_avail_mvmt_org_idx
  ON public.item_availability_movements(organization_id);
CREATE INDEX IF NOT EXISTS item_avail_mvmt_item_idx
  ON public.item_availability_movements(item_availability_id);
CREATE INDEX IF NOT EXISTS item_avail_mvmt_point_idx
  ON public.item_availability_movements(distribution_point_id);
CREATE INDEX IF NOT EXISTS item_avail_mvmt_created_idx
  ON public.item_availability_movements(created_at DESC);
CREATE INDEX IF NOT EXISTS item_avail_mvmt_org_created_idx
  ON public.item_availability_movements(organization_id, created_at DESC);

-- ============================================================================
-- 5. RLS: SELECT-only, org-scoped + permission-gated. No write policy at all.
-- ============================================================================

ALTER TABLE public.item_availability_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "avail_mvmt_select_perm" ON public.item_availability_movements;

CREATE POLICY "avail_mvmt_select_perm" ON public.item_availability_movements
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'availability.movements.view')
    )
  );

-- No INSERT policy, no UPDATE policy, no DELETE policy — intentional.
-- Movement rows are immutable and can only ever be created by a future
-- SECURITY DEFINER RPC (which bypasses RLS internally, same pattern as
-- phoenix_upsert_availability), never by a direct client write.

-- ============================================================================
-- 6. Grants: authenticated gets SELECT only; anon gets nothing.
-- ============================================================================

REVOKE ALL ON TABLE public.item_availability_movements FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.item_availability_movements TO authenticated;
-- Explicitly documented as absent (idempotent no-op if never granted):
REVOKE INSERT, UPDATE, DELETE ON TABLE public.item_availability_movements FROM authenticated;

-- ============================================================================
-- VERIFY
-- ============================================================================

DO $$
DECLARE
  v_table_exists   boolean;
  v_rls_enabled    boolean;
  v_policy_count   int;
  v_select_qual    text;
  v_key_count      int;
BEGIN
  -- A. Table exists
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'item_availability_movements'
  ) INTO v_table_exists;
  ASSERT v_table_exists, 'VERIFY FAILED: item_availability_movements table not found';

  -- B. All 7 permission keys exist
  SELECT count(*) INTO v_key_count FROM permission_keys
  WHERE key IN (
    'availability.quantity.set', 'availability.quantity.add',
    'availability.quantity.subtract', 'availability.quantity.correct',
    'availability.movements.view', 'availability.movements.export',
    'availability.movements.print'
  );
  ASSERT v_key_count = 7,
    format('VERIFY FAILED: expected 7 new permission keys, found %s', v_key_count);

  -- C. Role defaults spot-check
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'institution_admin' AND permission_key = 'availability.quantity.correct') = true,
    'VERIFY FAILED: institution_admin should have availability.quantity.correct = true';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'warehouse_officer' AND permission_key = 'availability.quantity.correct') = false,
    'VERIFY FAILED: warehouse_officer should have availability.quantity.correct = false';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'port_officer' AND permission_key = 'availability.quantity.set') = false,
    'VERIFY FAILED: port_officer should have availability.quantity.set = false';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'port_officer' AND permission_key = 'availability.quantity.add') = true,
    'VERIFY FAILED: port_officer should have availability.quantity.add = true';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'viewer' AND permission_key = 'availability.movements.view') = true,
    'VERIFY FAILED: viewer should have availability.movements.view = true';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'viewer' AND permission_key = 'availability.movements.export') = false,
    'VERIFY FAILED: viewer should have availability.movements.export = false';

  -- D. RLS is enabled
  SELECT relrowsecurity INTO v_rls_enabled
  FROM pg_class WHERE relname = 'item_availability_movements' AND relnamespace = 'public'::regnamespace;
  ASSERT v_rls_enabled, 'VERIFY FAILED: RLS is not enabled on item_availability_movements';

  -- E. SELECT policy exists and checks availability.movements.view
  SELECT qual INTO v_select_qual FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'item_availability_movements'
    AND policyname = 'avail_mvmt_select_perm';
  ASSERT v_select_qual IS NOT NULL, 'VERIFY FAILED: avail_mvmt_select_perm policy not found';
  ASSERT v_select_qual LIKE '%availability.movements.view%',
    'VERIFY FAILED: avail_mvmt_select_perm does not check availability.movements.view';

  -- F. No INSERT/UPDATE/DELETE policy exists for any role
  SELECT count(*) INTO v_policy_count FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'item_availability_movements'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE');
  ASSERT v_policy_count = 0,
    format('VERIFY FAILED: expected 0 INSERT/UPDATE/DELETE policies on item_availability_movements, found %s', v_policy_count);

  -- G. Exactly 1 policy total (SELECT only)
  SELECT count(*) INTO v_policy_count FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'item_availability_movements';
  ASSERT v_policy_count = 1,
    format('VERIFY FAILED: expected exactly 1 policy (SELECT only) on item_availability_movements, found %s', v_policy_count);

  RAISE NOTICE '033 OK: 7 quantity-movement permission keys + role defaults seeded, item_availability_movements created as an immutable SELECT-only ledger (no INSERT/UPDATE/DELETE policy, no anon access, no RPC yet).';
END $$;

COMMIT;

-- ============================================================================
-- END OF MIGRATION 033
--
-- Post-apply manual verification (run in Supabase SQL Editor):
--
-- 1. Confirm the new permission keys and role defaults:
--    SELECT role, permission_key, allowed FROM role_permission_defaults
--    WHERE permission_key LIKE 'availability.quantity.%'
--       OR permission_key LIKE 'availability.movements.%'
--    ORDER BY permission_key, role;
--
-- 2. Confirm the table and its single SELECT policy:
--    SELECT policyname, cmd, roles FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'item_availability_movements';
--    -- expect exactly 1 row: avail_mvmt_select_perm | SELECT | {authenticated}
--
-- 3. Confirm no direct write is possible (expect RLS/grant denial, not success):
--    -- As any authenticated non-super user:
--    INSERT INTO item_availability_movements
--      (item_availability_id, organization_id, distribution_point_id,
--       scientific_name, movement_type, quantity_before, quantity_delta, quantity_after)
--    VALUES ('<any-id>', '<org-id>', '<point-id>', 'test', 'add', 0, 1, 1);
--    -- expect: permission denied for table item_availability_movements (no INSERT grant)
--
-- 4. Confirm anon has zero privileges:
--    SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND table_name = 'item_availability_movements'
--      AND grantee = 'anon';
--    -- expect: 0 rows
--
-- NEXT PHASE (not part of this migration): create phoenix_apply_availability_
-- movement() as a SECURITY DEFINER RPC that performs the row-locked read,
-- permission check, quantity computation, item_availability UPDATE, and
-- item_availability_movements INSERT atomically — see
-- AVAILABILITY-QUANTITY-MOVEMENT-MODE-AUDIT-A for the full design.
-- ============================================================================
