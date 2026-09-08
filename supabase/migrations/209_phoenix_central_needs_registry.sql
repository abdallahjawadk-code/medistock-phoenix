-- ============================================================================
-- CN-1A / M209 — CENTRAL NEEDS CORE REGISTRY + SECURITY
--
-- Foundational, additive schema for the Central Needs (annual pharmaceutical
-- needs planning) module. Introduces:
--   - central_needs_plans / central_needs_plan_revisions: annual plan +
--     versioned revision lifecycle, organization-owned.
--   - central_needs_source_files: immutable metadata for the original
--     imported workbook (filename/hash/opaque storage locator only — no
--     Supabase Storage bucket wiring exists anywhere in this codebase yet;
--     actual file-byte storage integration is explicitly deferred, see the
--     CN-1A proposal doc).
--   - central_needs_import_sessions: a parser-neutral import-attempt
--     envelope. Carries NO sheet/row/column/workbook-family assumptions —
--     the real parser contract lands in CN-2A.
--   - central_needs_field_overrides: the stable, generic override
--     representation for a future imported business value (field name,
--     previous/final value, reason, actor, timestamp), per v7.3 section 8.4.
--     Schema only — no line-level imported data exists yet to override
--     until CN-1B/CN-2A ship; this table stays empty until then.
--   - Four new permission keys (central_needs.view/import/edit/approve)
--     seeded into the existing permission_keys catalog with NO default
--     role grants — access is opt-in per profile via
--     profile_permission_overrides, narrower than migration 203's own
--     role-default grants, because Central Needs data (annual entitlement
--     matrices, internal override rationale) is restricted to specifically
--     authorized central-warehouse users per v7.3 section 1, not a whole
--     role by default.
--
-- Explicitly OUT OF SCOPE for this migration (see proposal doc for the
-- full rationale):
--   - No RPCs. Nothing except a service-role/superuser connection can write
--     to these tables yet — review/approval/import-finalization RPCs are
--     CN-1B. All client INSERT/UPDATE/DELETE grants are revoked, matching
--     migration 203's "no client write grant at all, every mutation goes
--     through an RPC" pattern for tables meant to be mutated only by
--     SECURITY DEFINER functions.
--   - No audit_logs writes. Every existing audit_logs writer in this
--     codebase is an explicit INSERT inside a SECURITY DEFINER RPC body;
--     with zero RPCs introduced here there is nothing to hook one into.
--     Deferred to CN-1B, when real RPCs exist.
--   - No XLS/XLSX/CSV/ZIP parser, no sheet/row/column shape assumptions,
--     no parser-specific CHECK constraint anywhere (CN-0C/CN-2A concern).
--   - No changes to warehouse_stock, any movement ledger,
--     inventory_transfer_suggestions, or any existing transfer/movement
--     RPC signature.
--   - No wiring into the organizations archive-dependency reciprocal guard
--     (migrations 201/202, `_phoenix_assert_parent_not_archived_v1`).
--     organization_id uses ON DELETE RESTRICT below, which blocks a HARD
--     delete of an organization that still owns Central Needs data, but
--     archival is a soft status flip (`organizations.archived_at`) that
--     RESTRICT does not intercept. Extending the reciprocal guard to these
--     five new tables is a reasonable follow-up but is not required by the
--     CN-1A task scope and touches a shared cross-cutting mechanism outside
--     it — flagged here and in the proposal doc rather than done silently.
--
-- Authorization: every RLS policy below calls
--   public.phoenix_status_center_authorized(organization_id, 'central_needs.*')
-- (defined in migration 092) rather than phoenix_profile_has_scoped_permission,
-- because the latter's `v_org_wide_roles` allowlist cannot grant an org-wide
-- claim to a resource-scoped role — central_warehouse_manager is deliberately
-- excluded from it (see migration 187/the CN-1A proposal doc). Using
-- phoenix_status_center_authorized lets a central_warehouse_manager who has
-- actually been granted a central_needs.* key act org-wide, exactly as v7.3
-- section 7/10 requires. Any future CN-1B RPC guard must call this same
-- function so RLS and RPC authorization never fork.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. central_needs_plans
-- ----------------------------------------------------------------------------
CREATE TABLE public.central_needs_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  plan_year       integer NOT NULL CHECK (plan_year BETWEEN 2000 AND 2100),
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'active', 'archived')),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, plan_year)
);

CREATE INDEX central_needs_plans_org_idx ON public.central_needs_plans(organization_id);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.central_needs_plans
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at();

COMMENT ON TABLE public.central_needs_plans IS
  'CN-1A: annual Central Needs plan header — organization-owned, plan-year scoped. No client write path; populated only by future CN-1B RPCs.';

-- ----------------------------------------------------------------------------
-- 2. central_needs_plan_revisions
-- ----------------------------------------------------------------------------
CREATE TABLE public.central_needs_plan_revisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         uuid NOT NULL REFERENCES public.central_needs_plans(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'submitted', 'approved', 'superseded', 'rejected')),
  approved_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, revision_number),
  -- approved_by/approved_at are a pair (both null or both set); once set they
  -- may only be set while status is 'approved' or 'superseded' — a superseded
  -- revision preserves its prior approval record (v7.3 section 11.2:
  -- "preserve previous approved revision") rather than having it wiped; a
  -- revision claiming 'approved' must actually carry an approver.
  CONSTRAINT central_needs_plan_revisions_approval_pair_chk CHECK (
    (approved_by IS NULL) = (approved_at IS NULL)
    AND (approved_by IS NULL OR status IN ('approved', 'superseded'))
    AND (status <> 'approved' OR approved_by IS NOT NULL)
  )
);

CREATE INDEX central_needs_plan_revisions_plan_idx ON public.central_needs_plan_revisions(plan_id);
CREATE INDEX central_needs_plan_revisions_org_idx  ON public.central_needs_plan_revisions(organization_id);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.central_needs_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at();

COMMENT ON TABLE public.central_needs_plan_revisions IS
  'CN-1A: versioned revision of a Central Needs plan with schema-level approval state (approved_by/approved_at). No client write path; populated only by future CN-1B RPCs.';

-- ----------------------------------------------------------------------------
-- 3. central_needs_source_files (immutable original-source evidence)
-- ----------------------------------------------------------------------------
CREATE TABLE public.central_needs_source_files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_revision_id  uuid NOT NULL REFERENCES public.central_needs_plan_revisions(id) ON DELETE RESTRICT,
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  original_filename text NOT NULL CHECK (length(original_filename) > 0),
  file_hash         text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  byte_size         bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  -- Opaque nullable reference only, per v7.3 review decision: no Supabase
  -- Storage bucket/provider/upload workflow exists in this codebase or is
  -- introduced here. Actual storage integration is a CN-2A/CN-1B concern.
  storage_locator   text,
  uploaded_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_revision_id, file_hash)
);

CREATE INDEX central_needs_source_files_revision_idx ON public.central_needs_source_files(plan_revision_id);
CREATE INDEX central_needs_source_files_org_idx      ON public.central_needs_source_files(organization_id);

COMMENT ON TABLE public.central_needs_source_files IS
  'CN-1A: immutable metadata for the original imported Central Needs workbook. storage_locator is an opaque nullable reference only (no Storage bucket wiring exists yet). Rows are never updated after creation — enforced by trigger.';

CREATE OR REPLACE FUNCTION public._phoenix_central_needs_source_immutability_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'central_needs_source_file_immutable'
    USING ERRCODE = '23514',
          DETAIL = 'Original Central Needs source-file evidence cannot be modified after creation.';
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_source_immutability_v1() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER central_needs_source_files_immutable
  BEFORE UPDATE ON public.central_needs_source_files
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_central_needs_source_immutability_v1();

-- DELETE is blocked by REVOKE alone (see grants below), not a second trigger —
-- matching migration 203's own reasoning: a delete-blocking trigger fires for
-- the table owner too and would block legitimate superuser-level maintenance
-- (a governed future migration disabling/re-enabling the trigger) for no
-- extra security benefit over the REVOKE.

-- ----------------------------------------------------------------------------
-- 4. central_needs_import_sessions (parser-neutral import envelope)
-- ----------------------------------------------------------------------------
CREATE TABLE public.central_needs_import_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_revision_id uuid NOT NULL REFERENCES public.central_needs_plan_revisions(id) ON DELETE RESTRICT,
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_file_id   uuid NOT NULL REFERENCES public.central_needs_source_files(id) ON DELETE RESTRICT,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  started_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  notes            text,
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX central_needs_import_sessions_revision_idx ON public.central_needs_import_sessions(plan_revision_id);
CREATE INDEX central_needs_import_sessions_org_idx      ON public.central_needs_import_sessions(organization_id);
CREATE INDEX central_needs_import_sessions_source_idx   ON public.central_needs_import_sessions(source_file_id);

COMMENT ON TABLE public.central_needs_import_sessions IS
  'CN-1A: parser-neutral import-attempt envelope. No sheet/row/column/workbook-family assumption anywhere — the real parser output contract lands in CN-2A and is persisted by CN-1B.';

-- ----------------------------------------------------------------------------
-- 5. central_needs_field_overrides (stable, generic override representation)
-- ----------------------------------------------------------------------------
CREATE TABLE public.central_needs_field_overrides (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_revision_id    uuid NOT NULL REFERENCES public.central_needs_plan_revisions(id) ON DELETE RESTRICT,
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  -- Stable logical identifier of whatever is being overridden. Intentionally
  -- generic text, not a FK: no line-level imported entity exists yet in
  -- CN-1A for this to reference (CN-1B/CN-2A introduce one).
  target_entity       text NOT NULL CHECK (length(target_entity) > 0),
  field_name          text NOT NULL CHECK (length(field_name) > 0),
  previous_value      jsonb,
  final_value         jsonb,
  override_reason     text NOT NULL CHECK (length(override_reason) > 0),
  override_note       text,
  override_reference  text,
  actor_id            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX central_needs_field_overrides_revision_idx ON public.central_needs_field_overrides(plan_revision_id);
CREATE INDEX central_needs_field_overrides_org_idx      ON public.central_needs_field_overrides(organization_id);

COMMENT ON TABLE public.central_needs_field_overrides IS
  'CN-1A: stable, generic append-only override ledger (field name, previous/final value, reason, actor, timestamp) per v7.3 section 8.4. Schema only — stays empty until CN-1B/CN-2A introduce real line-level rows to override.';

-- ----------------------------------------------------------------------------
-- 6. Central Needs permission keys — declared, NO default role grants.
--    Central Needs data (annual entitlement matrices, internal override
--    rationale) is restricted to specifically authorized central-warehouse
--    users per v7.3 section 1/section 10, not a whole role by default —
--    narrower than migration 203's role-default grants. Access is opt-in
--    per profile via the existing profile_permission_overrides mechanism;
--    no new plumbing is required for that (migration 010).
-- ----------------------------------------------------------------------------
INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES
  ('central_needs.view',    'central_needs', 'view',    'View Central Needs plans',             'عرض خطط الاحتياجات المركزية',           false),
  ('central_needs.import',  'central_needs', 'import',  'Import Central Needs data',             'استيراد بيانات الاحتياجات المركزية',     false),
  ('central_needs.edit',    'central_needs', 'edit',    'Edit Central Needs data',               'تعديل بيانات الاحتياجات المركزية',       false),
  ('central_needs.approve', 'central_needs', 'approve', 'Approve Central Needs plan revision',   'اعتماد مراجعة خطة الاحتياجات المركزية', true)
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 7. RLS — SELECT gated on central_needs.view via
--    phoenix_status_center_authorized; no write policy anywhere. All
--    mutation is deferred to future SECURITY DEFINER RPCs (CN-1B); direct
--    client INSERT/UPDATE/DELETE is revoked outright, matching migration
--    203's "no client write grant at all" pattern.
-- ----------------------------------------------------------------------------

ALTER TABLE public.central_needs_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_plans FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_plans FROM PUBLIC;
REVOKE ALL ON TABLE public.central_needs_plans FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.central_needs_plans FROM authenticated;
GRANT SELECT ON TABLE public.central_needs_plans TO authenticated;
CREATE POLICY central_needs_plans_select_authorized
  ON public.central_needs_plans FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));

ALTER TABLE public.central_needs_plan_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_plan_revisions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_plan_revisions FROM PUBLIC;
REVOKE ALL ON TABLE public.central_needs_plan_revisions FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.central_needs_plan_revisions FROM authenticated;
GRANT SELECT ON TABLE public.central_needs_plan_revisions TO authenticated;
CREATE POLICY central_needs_plan_revisions_select_authorized
  ON public.central_needs_plan_revisions FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));

ALTER TABLE public.central_needs_source_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_source_files FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_source_files FROM PUBLIC;
REVOKE ALL ON TABLE public.central_needs_source_files FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.central_needs_source_files FROM authenticated;
GRANT SELECT ON TABLE public.central_needs_source_files TO authenticated;
CREATE POLICY central_needs_source_files_select_authorized
  ON public.central_needs_source_files FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));

ALTER TABLE public.central_needs_import_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_import_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_import_sessions FROM PUBLIC;
REVOKE ALL ON TABLE public.central_needs_import_sessions FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.central_needs_import_sessions FROM authenticated;
GRANT SELECT ON TABLE public.central_needs_import_sessions TO authenticated;
CREATE POLICY central_needs_import_sessions_select_authorized
  ON public.central_needs_import_sessions FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));

ALTER TABLE public.central_needs_field_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_field_overrides FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_field_overrides FROM PUBLIC;
REVOKE ALL ON TABLE public.central_needs_field_overrides FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.central_needs_field_overrides FROM authenticated;
GRANT SELECT ON TABLE public.central_needs_field_overrides TO authenticated;
CREATE POLICY central_needs_field_overrides_select_authorized
  ON public.central_needs_field_overrides FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));

-- ============================================================================
-- VERIFY
-- ============================================================================
DO $verify$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files',
    'central_needs_import_sessions', 'central_needs_field_overrides'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED (209): table % is missing', t;
    END IF;
    IF NOT (
      SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass
    ) THEN
      RAISE EXCEPTION 'VERIFY FAILED (209): table % does not have RLS enabled+forced', t;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM public.permission_keys WHERE module = 'central_needs') <> 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED (209): expected exactly 4 central_needs.* permission keys';
  END IF;

  IF EXISTS (SELECT 1 FROM public.role_permission_defaults WHERE permission_key LIKE 'central_needs.%') THEN
    RAISE EXCEPTION 'VERIFY FAILED (209): central_needs.* must have zero default role grants — access is opt-in via profile_permission_overrides only';
  END IF;

  IF to_regprocedure('public._phoenix_central_needs_source_immutability_v1()') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (209): source-file immutability trigger function is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM aclexplode((
      SELECT proacl FROM pg_proc WHERE oid = to_regprocedure('public._phoenix_central_needs_source_immutability_v1()')
    ))
    WHERE grantee = 0 AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (209): PUBLIC (grantee OID 0) still has EXECUTE on the source-file immutability trigger function';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'central_needs_source_files_immutable'
      AND tgrelid = 'public.central_needs_source_files'::regclass
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (209): source-file immutability trigger is not attached';
  END IF;
END;
$verify$;

COMMIT;

-- ============================================================================
-- ROLLBACK (documentation only — not executed):
--
--   BEGIN;
--   DROP TABLE IF EXISTS public.central_needs_field_overrides;
--   DROP TABLE IF EXISTS public.central_needs_import_sessions;
--   DROP TRIGGER IF EXISTS central_needs_source_files_immutable ON public.central_needs_source_files;
--   DROP TABLE IF EXISTS public.central_needs_source_files;
--   DROP FUNCTION IF EXISTS public._phoenix_central_needs_source_immutability_v1();
--   DROP TABLE IF EXISTS public.central_needs_plan_revisions;
--   DROP TABLE IF EXISTS public.central_needs_plans;
--   DELETE FROM public.permission_keys WHERE module = 'central_needs';
--   COMMIT;
-- ============================================================================
