-- =============================================================================
-- MediStock Phoenix V2 — Migration 062: User RBAC Scope Foundation (additive)
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
--
-- Prerequisites: Migrations 001–061 must ALL be applied first. Migration 061 is
-- REQUIRED — this migration replaces 061's dispatch SELECT policies and pins the
-- assignment table's outlet target to distribution_points_id_org_uniq, which 061
-- creates. See "APPLY ORDER" below.
--
-- USER-RBAC-U1-SCOPE-062-IMPLEMENT-A
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES
-- ─────────────────────────────────────────────────────────────────────────────
--   Turns "which warehouse / which outlet is this user actually responsible
--   for?" from an unanswerable question into a durable, structurally-enforced
--   database fact, and rebuilds warehouse/dispatch read authorization on top of
--   it. Seven parts:
--
--   A. public.profile_scope_assignments — durable warehouse/outlet assignment
--      records, with a fail-closed validation trigger.
--   B. New permission keys (user scope, warehouse stock, reports, audit).
--   C. Role-default corrections — most importantly, warehouse_officer LOSES
--      warehouses.manage (it is a DATA ENTRY role, not a warehouse owner).
--   D. phoenix_profile_has_scoped_permission — a NEW, additive scope-aware
--      helper. The existing global helper is NOT touched.
--   E. Scope-aware SELECT policies replacing 060's warehouse/stock/movement
--      policies and 061's dispatch policies.
--   F. trg_protect_last_super_admin — the final active super_admin cannot be
--      deleted, disabled, demoted or org-scoped out of existence.
--   G. profile_permission_overrides safety constraints (PK unchanged).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY AN ASSIGNMENT TABLE, AND NOT PROFILE COLUMNS OR OVERRIDE SCOPE COLUMNS
-- ─────────────────────────────────────────────────────────────────────────────
--   • profiles.warehouse_id / profiles.distribution_point_id would allow exactly
--     ONE assignment per user and would carry no history: a revocation would be
--     an UPDATE that destroys the record of what was revoked, by whom and why.
--     The product needs one officer to cover several warehouses/outlets, and it
--     needs the revocation trail. Neither is expressible in a profile column.
--   • profile_permission_overrides cannot be the assignment model either: its
--     PRIMARY KEY is (profile_id, permission_key), so a user could hold at most
--     one scoped row PER PERMISSION KEY. Two warehouses × one key is
--     unrepresentable, and widening that PK would silently change the meaning of
--     every existing override row. Migration 062 therefore does NOT touch that
--     PK (part G) — the override table stays a three-state permission opinion,
--     never an assignment ledger.
--   • profiles.organization_id remains the AUTHORITATIVE organization scope. An
--     assignment never widens it; it only narrows within it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SAME-ORGANIZATION INTEGRITY (three independent layers, all fail-closed)
-- ─────────────────────────────────────────────────────────────────────────────
--   An assignment involves THREE parents that must all agree on one org: the
--   profile, the assignment row, and the warehouse/outlet target.
--
--   1. Target ↔ assignment org: STRUCTURAL, via composite FKs to
--      warehouses(id, organization_id) [060] and
--      distribution_points(id, organization_id) [061]. A warehouse from another
--      organization cannot be named at all — not by a bug, not by a
--      SECURITY DEFINER RPC that forgets a check, not by service_role.
--   2. Profile ↔ assignment org: a normal FK CANNOT express this (it is an
--      equality between two different parents' columns, not a lookup), so it is
--      enforced by trg_validate_profile_scope_assignment, which is fail-closed:
--      it raises unless it can positively prove the orgs match.
--   3. Target must be live: an ACTIVE assignment to an archived/inactive
--      warehouse or outlet is rejected by the same trigger. This is deliberately
--      NOT a CHECK — status lives on the parent row and can change after the
--      assignment is written, so the invariant is enforced at write time and
--      re-proved by phoenix_profile_has_warehouse_assignment /
--      phoenix_profile_has_point_assignment at every read.
--
--   Layer 3's read-time re-proof is what makes archiving a warehouse
--   immediately effective without a data migration: the assignment row survives
--   as history, but it stops authorizing anything the moment its target is no
--   longer active.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WAREHOUSE OFFICER: DATA ENTRY, NOT OWNERSHIP (the load-bearing correction)
-- ─────────────────────────────────────────────────────────────────────────────
--   Migration 010 granted warehouse_officer `warehouses.manage`, and migration
--   060 then made that key genuinely powerful: it now authorizes INSERT and
--   UPDATE on warehouse master records org-wide. A Warehouse Data Entry Officer
--   holding it could create warehouses, rename them, change their code, flip
--   is_main (moving the organization's authoritative main warehouse), and
--   archive masters — none of which is its job, and all of it org-wide rather
--   than limited to the warehouses it was actually assigned.
--
--   This migration sets that default to false and replaces it with precise
--   stock-level keys (warehouse_stock.view/adjust/correct/movements_view). The
--   role keeps `warehouses.view` so it can still see its warehouses.
--
--   NOTE the deliberate asymmetry: 060's wh_insert_perm / wh_update_perm
--   policies are NOT modified here. They already gate on warehouses.manage, and
--   removing the default is what closes the hole. An operator who deliberately
--   grants warehouses.manage back to a specific person via an override still
--   gets 060's org-scoped behavior — that is an explicit, audited decision, not
--   a silent role default.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A NEW HELPER INSTEAD OF CHANGING THE OLD ONE
-- ─────────────────────────────────────────────────────────────────────────────
--   phoenix_profile_has_permission(uuid, text) is called by ~40 policies and
--   RPCs across migrations 010–061. Teaching it about scope would change the
--   meaning of every one of those call sites at once, in a single unreviewable
--   step, including paths (availability, QR, exchange, alerts) that have no
--   warehouse/outlet concept at all. So it is left EXACTLY as migration 017
--   defines it — this migration's VERIFY block proves its live source is still
--   normalized-identical to 017's, and fails the whole transaction if it drifted.
--
--   phoenix_profile_has_scoped_permission is strictly ADDITIVE and strictly
--   NARROWER: it calls the old helper and can only ever subtract from its
--   answer. It never returns true where the global helper returns false (except
--   for super_admin, which the global helper already answers true for via its
--   all-keys role defaults).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- APPLY ORDER (both migrations, one maintenance window)
-- ─────────────────────────────────────────────────────────────────────────────
--   1. Run the pre-apply readiness checks at the bottom of this file.
--   2. Apply committed migration 061.
--   3. IMMEDIATELY apply this migration (062).
--   4. Run the post-apply verification at the bottom of this file.
--   5. Keep dispatch functionality unexposed in the UI until BOTH succeed.
--
--   If 062 fails, its transaction rolls back completely and 061 remains applied
--   with its own organization-scoped read policies. That state is SAFE but not
--   final: dispatch reads are org-wide rather than assignment-scoped, no dispatch
--   RPC exists (062 does not create them either — that is 063), and the dispatch
--   tables should still be empty. Fix forward promptly within the window.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
--   • Does NOT modify migrations 001–061 in any way.
--   • Does NOT modify phoenix_profile_has_permission(uuid, text).
--   • Does NOT create any user-administration RPC (create/assign/revoke/reset) —
--     migration 063 owns those.
--   • Does NOT create any dispatch workflow RPC — also 063 scope.
--   • Does NOT create any assignment ROW. Assignments are made by 063's RPCs.
--   • Does NOT change profile_permission_overrides' PRIMARY KEY.
--   • Does NOT copy role defaults into override rows.
--   • Does NOT remove any role from profiles_role_check.
--   • Does NOT touch the Edge Function admin-user-lifecycle or its existing
--     LAST_SUPER_ADMIN check (063 maps the new DB token cleanly).
--   • Does NOT touch get_public_qr_payload, Deep Clean (055), item_availability,
--     or the inter-org exchange/alert domains.
--   • Does NOT DELETE or TRUNCATE any row, drop any table, column or function.
--   • Does NOT grant anon anything, anywhere.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
--   DROP TRIGGER trg_protect_last_super_admin ON public.profiles;
--   DROP FUNCTION public.phoenix_protect_last_super_admin();
--   DROP TRIGGER trg_validate_ppo_scope ON public.profile_permission_overrides;
--   DROP FUNCTION public.phoenix_validate_ppo_scope();
--   ALTER TABLE public.profile_permission_overrides
--     DROP CONSTRAINT ppo_single_resource_scope_chk,
--     DROP CONSTRAINT ppo_scope_warehouse_org_fk,
--     DROP CONSTRAINT ppo_scope_point_org_fk;
--   DROP POLICY "psa_select_scoped" ON public.profile_scope_assignments;
--   DROP TRIGGER trg_validate_profile_scope_assignment ON public.profile_scope_assignments;
--   DROP FUNCTION public.phoenix_validate_profile_scope_assignment();
--   DROP TABLE public.profile_scope_assignments;
--   DROP FUNCTION public.phoenix_profile_has_scoped_permission(uuid, text, uuid, uuid, uuid);
--   DROP FUNCTION public.phoenix_profile_has_warehouse_assignment(uuid, uuid);
--   DROP FUNCTION public.phoenix_profile_has_point_assignment(uuid, uuid);
--   -- restore the superseded policies by re-applying, verbatim:
--   --   060 section B  (wh_select_perm)
--   --   060 section E  (warehouse_stock_select_perm, warehouse_stock_mov_select_perm)
--   --   061 section I  (warehouse_dispatches_select_perm, warehouse_dispatch_lines_select_perm)
--   -- and restore the role defaults this migration corrected:
--   UPDATE role_permission_defaults SET allowed = true
--     WHERE role = 'warehouse_officer' AND permission_key = 'warehouses.manage';
--   -- (the new permission_keys rows may be left in place; they authorize nothing
--   --  once the policies above no longer reference them.)
--   No data rollback is needed: this migration adds only new objects, defaulted
--   columns and new keys, and writes no application row.
-- =============================================================================

begin;

-- =============================================================================
-- A. profile_scope_assignments — durable warehouse/outlet assignment records
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.profile_scope_assignments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  profile_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- The org this assignment lives in. Must equal profiles.organization_id (the
  -- authoritative scope) — proved by trg_validate_profile_scope_assignment.
  -- RESTRICT, not CASCADE: an organization holding assignment history cannot be
  -- deleted out from under it. Retention beats convenience, exactly as 060/061
  -- decided for warehouse and dispatch history.
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,

  -- text + CHECK, never a Postgres enum: every status/type column in this schema
  -- is text+CHECK (warehouses.status, movement_type, dispatch status), and an
  -- enum cannot be altered inside a transaction.
  scope_type            text NOT NULL,

  warehouse_id          uuid,
  distribution_point_id uuid,

  is_active             boolean NOT NULL DEFAULT true,

  -- Actor references are RETENTION-SOFT (061 precedent): SET NULL, never
  -- RESTRICT. A person who once assigned or revoked a scope must not thereby
  -- become permanently undeletable. The durable business record is
  -- assigned_at / revoked_at / revoke_reason (plain columns nothing can null)
  -- plus the audit_logs snapshot migration 063 writes.
  assigned_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at           timestamptz NOT NULL DEFAULT now(),
  revoked_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at            timestamptz,
  revoke_reason         text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- Structural org pinning of the warehouse target (060's composite FK target).
  -- MATCH SIMPLE (the default) is REQUIRED here, not incidental: when
  -- warehouse_id IS NULL — i.e. this is an outlet assignment — the constraint is
  -- not enforced at all, which is exactly the intent. MATCH FULL would reject
  -- every outlet row.
  CONSTRAINT psa_warehouse_org_fk
    FOREIGN KEY (warehouse_id, organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,

  -- Structural org pinning of the outlet target (061's composite FK target).
  CONSTRAINT psa_point_org_fk
    FOREIGN KEY (distribution_point_id, organization_id)
    REFERENCES public.distribution_points (id, organization_id) ON DELETE RESTRICT,

  CONSTRAINT psa_scope_type_chk
    CHECK (scope_type IN ('warehouse', 'distribution_point')),

  -- Exactly one target, matching the declared scope_type. A row can never name
  -- both a warehouse and an outlet, and can never name neither — so no read path
  -- ever has to guess which one it meant.
  CONSTRAINT psa_target_matches_scope_chk
    CHECK (
      CASE scope_type
        WHEN 'warehouse' THEN
          warehouse_id IS NOT NULL AND distribution_point_id IS NULL
        WHEN 'distribution_point' THEN
          distribution_point_id IS NOT NULL AND warehouse_id IS NULL
        ELSE false
      END
    ),

  -- The revocation state machine, expressed as data.
  --
  -- READ BEFORE EDITING: revoked_by is deliberately absent from the revoked
  -- branch. It is an FK with ON DELETE SET NULL, and a CHECK may never require a
  -- nullable FK column to stay non-null — SET NULL only ever makes a column MORE
  -- null, so such a rule would make any user who ever revoked an assignment
  -- permanently undeletable. This is the same retention bug 061 fixed in
  -- warehouse_dispatch_lines_decision_chk; it is not repeated here.
  --
  -- The `IS NULL` requirements on the active branch are always SET NULL-safe
  -- (they can only become MORE true), so they stay complete.
  CONSTRAINT psa_status_chk
    CHECK (
      CASE WHEN is_active
        THEN revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL
        ELSE revoked_at IS NOT NULL
             AND revoke_reason IS NOT NULL
             AND btrim(revoke_reason) <> ''
      END
    ),

  CONSTRAINT psa_revoke_reason_chk
    CHECK (revoke_reason IS NULL OR (btrim(revoke_reason) = revoke_reason AND revoke_reason <> '')),

  CONSTRAINT psa_revoked_after_assigned_chk
    CHECK (revoked_at IS NULL OR revoked_at >= assigned_at)
);

-- One ACTIVE assignment per (profile, warehouse) — a duplicate active row would
-- make "revoke this assignment" ambiguous. Partial-unique idiom matches 029/051/060.
CREATE UNIQUE INDEX IF NOT EXISTS psa_active_warehouse_uniq
  ON public.profile_scope_assignments (profile_id, warehouse_id)
  WHERE is_active = true AND scope_type = 'warehouse';

CREATE UNIQUE INDEX IF NOT EXISTS psa_active_point_uniq
  ON public.profile_scope_assignments (profile_id, distribution_point_id)
  WHERE is_active = true AND scope_type = 'distribution_point';

-- Note what these indexes deliberately DO NOT prevent:
--   • one profile actively assigned to several DIFFERENT warehouses (the keys
--     differ, so both rows are accepted) — a required product behavior;
--   • one profile actively assigned to several DIFFERENT outlets — likewise;
--   • many REVOKED rows for the same (profile, target) — history is preserved,
--     and re-assigning after a revocation is a new row, not an edit to the old
--     one. `is_active = true` in the predicate is what allows that.

CREATE INDEX IF NOT EXISTS psa_profile_idx      ON public.profile_scope_assignments (profile_id);
CREATE INDEX IF NOT EXISTS psa_org_idx          ON public.profile_scope_assignments (organization_id);
CREATE INDEX IF NOT EXISTS psa_warehouse_idx    ON public.profile_scope_assignments (warehouse_id);
CREATE INDEX IF NOT EXISTS psa_point_idx        ON public.profile_scope_assignments (distribution_point_id);
-- The exact lookup every scoped read performs.
CREATE INDEX IF NOT EXISTS psa_active_lookup_idx
  ON public.profile_scope_assignments (profile_id, scope_type)
  WHERE is_active = true;

COMMENT ON TABLE public.profile_scope_assignments IS
  'Durable record of which warehouses / distribution points a profile is '
  'responsible for. One row per (profile, target); at most one ACTIVE row per '
  'pair, unlimited revoked history. Organization agreement with the target is '
  'structural (composite FKs to warehouses/distribution_points); agreement with '
  'profiles.organization_id and the target''s active status are enforced by '
  'trg_validate_profile_scope_assignment. Rows are written ONLY by migration '
  '063 SECURITY DEFINER RPCs — there is no direct client INSERT/UPDATE/DELETE '
  'path, by design, matching warehouse_stock (060) and warehouse_dispatches '
  '(061). super_admin is deliberately NOT represented here: it is a platform '
  'role and is never constrained by an assignment. Not public: anon holds no '
  'privilege and no policy.';

COMMENT ON COLUMN public.profile_scope_assignments.scope_type IS
  'Either ''warehouse'' or ''distribution_point''. Determines which target '
  'column is populated (psa_target_matches_scope_chk) and which authority the '
  'row confers: a warehouse assignment NEVER authorizes outlet operations, and '
  'an outlet assignment NEVER authorizes warehouse operations.';

COMMENT ON COLUMN public.profile_scope_assignments.is_active IS
  'False means revoked. Revocation is a state change plus a mandatory reason and '
  'timestamp — never a DELETE. revoked_by may later become NULL if that user is '
  'deleted (ON DELETE SET NULL); revoked_at/revoke_reason are the durable record.';

-- ─────────────────────────────────────────────────────────────────────────────
-- AUDIT CONTRACT FOR MIGRATION 063 (no new audit table — audit_logs is the one)
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 062 creates NO audit table and writes NO audit row: it makes no
-- application-level decision to record. Migration 063's user-administration and
-- dispatch RPCs MUST write the existing public.audit_logs (001/013/014 shape:
-- organization_id, actor_id, actor_role, action, entity_type, entity_id,
-- payload; the 014 trigger adds the actor identity snapshot) using exactly these
-- action values, and no others:
--
--   scope_assigned            entity_type 'profile_scope_assignment'
--   scope_revoked             entity_type 'profile_scope_assignment' (+ reason)
--   permission_granted        entity_type 'profile'
--   permission_denied         entity_type 'profile'
--   override_removed          entity_type 'profile'
--   permissions_reset         entity_type 'profile'  (already emitted by 017)
--   role_changed              entity_type 'profile'
--   organization_changed      entity_type 'profile'
--   last_super_admin_protected entity_type 'profile' — recorded when 063 catches
--                             this migration's LAST_SUPER_ADMIN_PROTECTED token
--
-- audit_logs.action carries no CHECK constraint (001), so this list is a
-- reviewed contract rather than a database restriction. Keep it that way: adding
-- a CHECK now would have to enumerate every historical action value ever
-- written, and getting that list wrong would break existing write paths.
COMMENT ON COLUMN public.profile_scope_assignments.revoke_reason IS
  'Mandatory, trimmed and non-empty on every revoked row. Migration 063 copies '
  'it into the audit_logs ''scope_revoked'' payload.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.profile_scope_assignments
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- A2. Fail-closed assignment validation trigger
-- =============================================================================
-- Enforces the two invariants a composite FK structurally cannot express:
--   1. the assignment's org equals the PROFILE's org (equality across two
--      different parents, not a lookup into one);
--   2. an ACTIVE assignment names a LIVE target (status = 'active').
--
-- Fail-closed: every path either RAISEs or returns a row it has positively
-- proved valid. There is no `EXCEPTION WHEN OTHERS` and no branch that lets an
-- unproven row through. A profile with a NULL organization_id (e.g. a platform
-- super_admin) can therefore never be assigned a scope at all.

CREATE OR REPLACE FUNCTION public.phoenix_validate_profile_scope_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile_org    uuid;
  v_profile_found  boolean;
  v_target_status  text;
BEGIN
  SELECT p.organization_id, true INTO v_profile_org, v_profile_found
  FROM public.profiles p
  WHERE p.id = NEW.profile_id;

  -- Defensive: the FK already guarantees the profile exists, but this trigger
  -- must not depend on constraint evaluation order to stay fail-closed.
  IF NOT COALESCE(v_profile_found, false) THEN
    RAISE EXCEPTION 'SCOPE_ASSIGNMENT_PROFILE_NOT_FOUND: profile % does not exist', NEW.profile_id
      USING ERRCODE = '23503';
  END IF;

  IF v_profile_org IS NULL THEN
    RAISE EXCEPTION 'SCOPE_ASSIGNMENT_ORG_MISMATCH: profile % has no organization and cannot hold a scope assignment', NEW.profile_id
      USING ERRCODE = '23514';
  END IF;

  IF v_profile_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'SCOPE_ASSIGNMENT_ORG_MISMATCH: assignment organization % does not match profile organization %', NEW.organization_id, v_profile_org
      USING ERRCODE = '23514';
  END IF;

  -- An ACTIVE assignment must name a live target. Revoked rows are history and
  -- are deliberately exempt: a warehouse archived AFTER an assignment was
  -- revoked must not make that historical row unwritable.
  IF NEW.is_active THEN
    IF NEW.scope_type = 'warehouse' THEN
      SELECT w.status INTO v_target_status
      FROM public.warehouses w
      WHERE w.id = NEW.warehouse_id AND w.organization_id = NEW.organization_id;

      IF v_target_status IS NULL THEN
        RAISE EXCEPTION 'SCOPE_ASSIGNMENT_TARGET_NOT_FOUND: warehouse % not found in organization %', NEW.warehouse_id, NEW.organization_id
          USING ERRCODE = '23503';
      END IF;

      IF v_target_status <> 'active' THEN
        RAISE EXCEPTION 'SCOPE_ASSIGNMENT_TARGET_INACTIVE: warehouse % is % — an active assignment requires an active warehouse', NEW.warehouse_id, v_target_status
          USING ERRCODE = '23514';
      END IF;

    ELSIF NEW.scope_type = 'distribution_point' THEN
      SELECT d.status INTO v_target_status
      FROM public.distribution_points d
      WHERE d.id = NEW.distribution_point_id AND d.organization_id = NEW.organization_id;

      IF v_target_status IS NULL THEN
        RAISE EXCEPTION 'SCOPE_ASSIGNMENT_TARGET_NOT_FOUND: distribution point % not found in organization %', NEW.distribution_point_id, NEW.organization_id
          USING ERRCODE = '23503';
      END IF;

      IF v_target_status <> 'active' THEN
        RAISE EXCEPTION 'SCOPE_ASSIGNMENT_TARGET_INACTIVE: distribution point % is % — an active assignment requires an active outlet', NEW.distribution_point_id, v_target_status
          USING ERRCODE = '23514';
      END IF;

    ELSE
      -- Unreachable while psa_scope_type_chk holds; fail closed regardless
      -- rather than silently accepting an unknown scope type.
      RAISE EXCEPTION 'SCOPE_ASSIGNMENT_UNKNOWN_SCOPE_TYPE: %', NEW.scope_type
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_profile_scope_assignment ON public.profile_scope_assignments;
CREATE TRIGGER trg_validate_profile_scope_assignment
  BEFORE INSERT OR UPDATE ON public.profile_scope_assignments
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_validate_profile_scope_assignment();

COMMENT ON FUNCTION public.phoenix_validate_profile_scope_assignment() IS
  'Fail-closed assignment validation: the assignment organization must equal '
  'profiles.organization_id, and an active assignment must name an active '
  'warehouse/outlet in that same organization. Raises rather than filtering; '
  'contains no exception handler that could swallow a failure.';

-- =============================================================================
-- A3. RLS + grants for the assignment table
-- =============================================================================
-- Read-only, and narrowly: super_admin sees everything; org user-managers see
-- their own organization; an ordinary officer sees ONLY its own active rows and
-- can never enumerate anyone else's. No write policy and no write grant — 063's
-- SECURITY DEFINER RPCs are the only write path, exactly as warehouse_stock
-- (060) and the dispatch tables (061) are written.

ALTER TABLE public.profile_scope_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "psa_select_scoped" ON public.profile_scope_assignments;

CREATE POLICY "psa_select_scoped" ON public.profile_scope_assignments
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    -- Own ACTIVE assignments only: an officer needs to know what it may work on,
    -- not its own revocation history, and never anyone else's row.
    OR (profile_id = auth.uid() AND is_active = true)
    -- Org user-management oversight.
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_my_role() IN ('institution_admin', 'hospital_admin')
      AND phoenix_profile_has_permission(auth.uid(), 'users.view')
    )
  );

REVOKE ALL ON TABLE public.profile_scope_assignments FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.profile_scope_assignments TO authenticated;
-- Explicitly documented as absent (idempotent no-op if never granted):
REVOKE INSERT, UPDATE, DELETE ON TABLE public.profile_scope_assignments FROM authenticated;

-- =============================================================================
-- B. New permission keys
-- =============================================================================
-- Uses the exact permission_keys contract from migration 010:
--   (key, module, action, label_en, label_ar, is_dangerous)
-- Idempotent via ON CONFLICT DO NOTHING, matching every existing permission
-- migration. None of these keys exists before this migration (VERIFY asserts the
-- count), so nothing is redefined.
--
-- is_dangerous follows 010/011/061's meaning: true = "granting this to someone
-- who does not already hold it requires the granter to hold it too" (017's
-- NEEDS_AUTHORITY_FOR_DANGEROUS path). Stock adjustment/correction and financial
-- reporting qualify; reading does not.

INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES
  -- User scope + permission administration (the three-type user-management UI's
  -- database side; migration 063 builds the RPCs that consume these).
  ('users.edit_scope','users','edit_scope','Edit user scope','تعديل نطاق المستخدم',true),
  ('users.reset_permissions','users','reset_permissions','Reset user permissions','إعادة تعيين صلاحيات المستخدم',true),

  -- Warehouse stock — precise keys replacing the overloaded warehouses.manage.
  ('warehouse_stock.view','warehouse_stock','view','View warehouse stock','عرض مخزون المذخر',false),
  ('warehouse_stock.adjust','warehouse_stock','adjust','Adjust warehouse stock','تعديل مخزون المذخر',true),
  ('warehouse_stock.correct','warehouse_stock','correct','Correct warehouse stock','تصحيح مخزون المذخر',true),
  ('warehouse_stock.movements_view','warehouse_stock','movements_view','View stock movements','عرض حركات المخزون',false),

  -- Reporting.
  ('reports.view','reports','view','View reports','عرض التقارير',false),
  ('reports.financial','reports','financial','View financial reports','عرض التقارير المالية',true),
  ('reports.export','reports','export','Export reports','تصدير التقارير',true),

  -- Audit.
  ('audit.view','audit','view','View audit log','عرض سجل التدقيق',false)
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- C. Role default corrections
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- C1. warehouse_officer LOSES warehouses.manage
-- ─────────────────────────────────────────────────────────────────────────────
-- See the header. UPDATE to false rather than DELETE, deliberately: this file
-- contains no DELETE by design (its VERIFY and test suite both assert that), and
-- an explicit `allowed = false` row is a stronger, more legible statement than an
-- absent row — it survives any future re-run of migration 010's seed, which
-- would otherwise silently reinstate the grant via ON CONFLICT DO NOTHING.
UPDATE public.role_permission_defaults
   SET allowed = false
 WHERE role = 'warehouse_officer'
   AND permission_key = 'warehouses.manage';

-- warehouse_manager (legacy, migration 010 copied warehouse_officer's defaults
-- at that time) is deliberately NOT changed: it is a hidden legacy role that the
-- product does not assign, and quietly re-scoping legacy roles is out of this
-- migration's contract.

-- ─────────────────────────────────────────────────────────────────────────────
-- C2. Role defaults for the new keys
-- ─────────────────────────────────────────────────────────────────────────────
-- ON CONFLICT ... DO UPDATE is used ONLY for rows this migration owns (the ten
-- new keys). It can only ever set the value this file states explicitly, and
-- every `true` below is a deliberate grant reviewed against the role's job.
-- Nothing outside the new-key set is touched here.
--
-- Where a row says `false`, that is an EXPLICIT DENY, not an oversight: an absent
-- row already evaluates to false, but an explicit row makes the decision visible
-- in the permission matrix UI and immune to a later blanket re-seed.

INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  -- ───────────────────────────────────────────────────────────────────────────
  -- warehouse_officer — Warehouse Data Entry Officer.
  -- Stock is its job; warehouse master records and user administration are not.
  -- ───────────────────────────────────────────────────────────────────────────
  ('warehouse_officer','warehouse_stock.view',true),
  ('warehouse_officer','warehouse_stock.adjust',true),
  ('warehouse_officer','warehouse_stock.correct',true),
  ('warehouse_officer','warehouse_stock.movements_view',true),
  ('warehouse_officer','reports.view',true),
  ('warehouse_officer','audit.view',true),
  -- Financial figures and bulk export are a separate, deliberate decision.
  ('warehouse_officer','reports.financial',false),
  ('warehouse_officer','reports.export',false),
  ('warehouse_officer','users.edit_scope',false),
  ('warehouse_officer','users.reset_permissions',false),
  -- SEPARATION OF DUTY (061's load-bearing rule, restated as explicit denies):
  -- the sender must never be able to accept or reject its own dispatch.
  ('warehouse_officer','warehouse_dispatch.accept',false),
  ('warehouse_officer','warehouse_dispatch.reject',false),
  -- The correction this migration exists for, stated a second time as an
  -- INSERT-safe default in case the row above was never seeded by 010.
  ('warehouse_officer','warehouses.manage',false),

  -- ───────────────────────────────────────────────────────────────────────────
  -- port_officer — Outlet Data Entry Officer.
  -- Receives dispatches; never touches warehouse stock or warehouse masters.
  -- ───────────────────────────────────────────────────────────────────────────
  ('port_officer','reports.view',true),
  ('port_officer','audit.view',true),
  ('port_officer','reports.financial',false),
  ('port_officer','reports.export',false),
  ('port_officer','users.edit_scope',false),
  ('port_officer','users.reset_permissions',false),
  ('port_officer','warehouses.manage',false),
  ('port_officer','warehouse_stock.view',false),
  ('port_officer','warehouse_stock.adjust',false),
  ('port_officer','warehouse_stock.correct',false),
  ('port_officer','warehouse_stock.movements_view',false),
  -- Separation of duty, receiving side: never create, edit, send or cancel.
  ('port_officer','warehouse_dispatch.create',false),
  ('port_officer','warehouse_dispatch.edit_draft',false),
  ('port_officer','warehouse_dispatch.send',false),
  ('port_officer','warehouse_dispatch.cancel',false),

  -- ───────────────────────────────────────────────────────────────────────────
  -- institution_admin — organization-wide oversight (never platform-wide).
  -- Reads everything in its org and administers its users. Deliberately NOT
  -- granted stock adjust/correct: migration 012 gave it no warehouses.manage
  -- either, because it is an oversight role, not a data-entry one. Oversight
  -- that can silently rewrite the quantities it oversees is not oversight.
  -- ───────────────────────────────────────────────────────────────────────────
  ('institution_admin','warehouse_stock.view',true),
  ('institution_admin','warehouse_stock.movements_view',true),
  ('institution_admin','warehouse_stock.adjust',false),
  ('institution_admin','warehouse_stock.correct',false),
  ('institution_admin','reports.view',true),
  ('institution_admin','reports.financial',true),
  ('institution_admin','reports.export',true),
  ('institution_admin','audit.view',true),
  ('institution_admin','users.edit_scope',true),
  ('institution_admin','users.reset_permissions',true),

  -- ───────────────────────────────────────────────────────────────────────────
  -- hospital_admin — legacy org admin. Migration 010 gave it the same breadth as
  -- institution_admin, and the policies below name it alongside institution_admin
  -- for organization-wide compatibility, so its new-key defaults must match or
  -- those policies would grant it visibility it holds no key for.
  -- ───────────────────────────────────────────────────────────────────────────
  ('hospital_admin','warehouse_stock.view',true),
  ('hospital_admin','warehouse_stock.movements_view',true),
  ('hospital_admin','warehouse_stock.adjust',false),
  ('hospital_admin','warehouse_stock.correct',false),
  ('hospital_admin','reports.view',true),
  ('hospital_admin','reports.financial',true),
  ('hospital_admin','reports.export',true),
  ('hospital_admin','audit.view',true),
  ('hospital_admin','users.edit_scope',true),
  ('hospital_admin','users.reset_permissions',true),

  -- ───────────────────────────────────────────────────────────────────────────
  -- viewer — hidden legacy read-only role, own organization only.
  -- Read keys only. No write, no stock adjustment, no dispatch decision, no user
  -- management, no financial figures, no bulk export.
  -- ───────────────────────────────────────────────────────────────────────────
  ('viewer','warehouse_stock.view',true),
  ('viewer','warehouse_stock.movements_view',true),
  ('viewer','reports.view',true),
  ('viewer','audit.view',true),
  ('viewer','warehouse_stock.adjust',false),
  ('viewer','warehouse_stock.correct',false),
  ('viewer','reports.financial',false),
  ('viewer','reports.export',false),
  ('viewer','users.edit_scope',false),
  ('viewer','users.reset_permissions',false),

  -- ───────────────────────────────────────────────────────────────────────────
  -- monthly_status_officer — status reporting only. It holds no warehouse key
  -- today (010) and gains none here; reports.view/audit.view match its existing
  -- read-oriented semantics.
  -- ───────────────────────────────────────────────────────────────────────────
  ('monthly_status_officer','reports.view',true),
  ('monthly_status_officer','audit.view',true),
  ('monthly_status_officer','warehouse_stock.view',false),
  ('monthly_status_officer','warehouse_stock.adjust',false),
  ('monthly_status_officer','warehouse_stock.correct',false),
  ('monthly_status_officer','warehouse_stock.movements_view',false),
  ('monthly_status_officer','reports.financial',false),
  ('monthly_status_officer','reports.export',false),
  ('monthly_status_officer','users.edit_scope',false),
  ('monthly_status_officer','users.reset_permissions',false),

  -- ───────────────────────────────────────────────────────────────────────────
  -- transfer_manager — hidden legacy role with no current workflow. Explicitly
  -- denied every new key rather than left to an absent-row default.
  -- ───────────────────────────────────────────────────────────────────────────
  ('transfer_manager','warehouse_stock.view',false),
  ('transfer_manager','warehouse_stock.adjust',false),
  ('transfer_manager','warehouse_stock.correct',false),
  ('transfer_manager','warehouse_stock.movements_view',false),
  ('transfer_manager','reports.financial',false),
  ('transfer_manager','reports.export',false),
  ('transfer_manager','users.edit_scope',false),
  ('transfer_manager','users.reset_permissions',false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = excluded.allowed;

-- super_admin: repository convention (010, 061) seeds it from EVERY key rather
-- than hard-coding a list, so the ten new keys are added the same way. This
-- preserves its existing global behavior without weakening or re-stating it.
-- DO NOTHING (not DO UPDATE): an operator who has deliberately revoked a key
-- from super_admin must not have that decision silently reversed by a migration.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
  SELECT 'super_admin', key, true FROM public.permission_keys
ON CONFLICT (role, permission_key) DO NOTHING;

-- =============================================================================
-- D. Scope helper functions (ADDITIVE — the 017 helper is not touched)
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- D1. Assignment predicates
-- ─────────────────────────────────────────────────────────────────────────────
-- These exist because without them every scoped RLS policy would have to inline
-- the same five-way join (assignment × profile × target, with three status
-- checks), and one policy inlining it slightly differently is precisely how a
-- scope hole gets introduced. Two small predicates, used by four policies and by
-- the scoped helper below — this is not function proliferation, it is the single
-- definition of "actively assigned".
--
-- Fail-closed on every input: a NULL profile or target yields no matching row,
-- hence false. They return a boolean and nothing else, so they can never leak a
-- cross-organization identifier to their caller.
--
-- SECURITY DEFINER because RLS callers must be able to prove an assignment
-- exists without holding SELECT on profile_scope_assignments for other users
-- (psa_select_scoped deliberately denies exactly that).

CREATE OR REPLACE FUNCTION public.phoenix_profile_has_warehouse_assignment(
  p_profile_id   uuid,
  p_warehouse_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profile_scope_assignments a
    JOIN public.profiles   p ON p.id = a.profile_id
    JOIN public.warehouses w ON w.id = a.warehouse_id
    WHERE a.profile_id   = p_profile_id
      AND a.warehouse_id = p_warehouse_id
      AND a.scope_type   = 'warehouse'
      AND a.is_active    = true
      -- The assignment authorizes nothing once the person is disabled...
      AND p.status = 'active'
      -- ...nor once the warehouse is archived/inactive (re-proved at read time,
      -- so archiving a warehouse takes effect immediately, with no backfill).
      AND w.status = 'active'
      -- Organization agreement re-proved at read time rather than assumed from
      -- the write-time trigger: three-way, so no single drifted row authorizes.
      AND a.organization_id = p.organization_id
      AND a.organization_id = w.organization_id
  );
$$;

CREATE OR REPLACE FUNCTION public.phoenix_profile_has_point_assignment(
  p_profile_id            uuid,
  p_distribution_point_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profile_scope_assignments a
    JOIN public.profiles            p ON p.id = a.profile_id
    JOIN public.distribution_points d ON d.id = a.distribution_point_id
    WHERE a.profile_id            = p_profile_id
      AND a.distribution_point_id = p_distribution_point_id
      AND a.scope_type            = 'distribution_point'
      AND a.is_active             = true
      AND p.status = 'active'
      AND d.status = 'active'
      AND a.organization_id = p.organization_id
      AND a.organization_id = d.organization_id
  );
$$;

REVOKE ALL ON FUNCTION public.phoenix_profile_has_warehouse_assignment(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.phoenix_profile_has_point_assignment(uuid, uuid)     FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_profile_has_warehouse_assignment(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_profile_has_point_assignment(uuid, uuid)     TO authenticated;

COMMENT ON FUNCTION public.phoenix_profile_has_warehouse_assignment(uuid, uuid) IS
  'True only when the profile holds an ACTIVE warehouse scope assignment for an '
  'ACTIVE warehouse in the profile''s own organization, and the profile itself is '
  'active. Fail-closed on NULL input. Returns a boolean only — never an identifier.';

COMMENT ON FUNCTION public.phoenix_profile_has_point_assignment(uuid, uuid) IS
  'Outlet counterpart of phoenix_profile_has_warehouse_assignment. A warehouse '
  'assignment can never satisfy this, and vice versa: the two authorities are '
  'separate by design (psa_target_matches_scope_chk makes that structural).';

-- ─────────────────────────────────────────────────────────────────────────────
-- D2. phoenix_profile_has_scoped_permission — the new scope-aware helper
-- ─────────────────────────────────────────────────────────────────────────────
-- ADDITIVE. phoenix_profile_has_permission(uuid, text) is NOT modified, and this
-- function CALLS it rather than reimplementing it — so the two can never drift
-- into disagreeing about what a permission key means.
--
-- The contract, in one sentence: this function is the global helper's answer,
-- narrowed by organization and by resource assignment; it never broadens it.
--
-- ORDER MATTERS in the body below and is not stylistic:
--   • the both-targets check runs BEFORE any grant path, so an ambiguous request
--     can never be resolved by whichever target happens to match first;
--   • the org check runs BEFORE the permission check, so an override can never
--     be read as authority outside the profile's own organization;
--   • the assignment check runs LAST, so it narrows a grant and never creates one.
--
-- Deliberately NOT an OR over the two targets (rule 7): "warehouse W or outlet
-- P" would let a warehouse officer authorize an outlet operation by passing its
-- own warehouse alongside someone else's outlet. Supplying both is a caller bug,
-- and the only safe answer to a caller bug in an authorization function is false.
--
-- LANGUAGE plpgsql (not sql): the early-return structure is what makes each rule
-- individually reviewable and provably ordered. STABLE — it only reads. SECURITY
-- DEFINER — callers must not need SELECT on profiles/assignments to be checked.

CREATE OR REPLACE FUNCTION public.phoenix_profile_has_scoped_permission(
  p_profile_id            uuid,
  p_permission_key        text,
  p_organization_id       uuid DEFAULT NULL,
  p_warehouse_id          uuid DEFAULT NULL,
  p_distribution_point_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role   text;
  v_status text;
  v_org    uuid;
  -- Roles that legitimately answer organization-wide rather than per-resource.
  -- These are OVERSIGHT and READ roles: they hold no data-entry key that a
  -- resource scope would need to narrow (institution_admin/hospital_admin are
  -- denied warehouse_stock.adjust/correct in part C; viewer and
  -- monthly_status_officer hold read keys only). warehouse_officer, port_officer
  -- and their legacy twins are deliberately absent: they are operational roles
  -- and MUST name the resource they are acting on.
  v_org_wide_roles text[] := ARRAY[
    'institution_admin', 'hospital_admin', 'monthly_status_officer', 'viewer'
  ];
BEGIN
  -- Rule 1: unknown/absent inputs are never authority.
  IF p_profile_id IS NULL OR p_permission_key IS NULL OR btrim(p_permission_key) = '' THEN
    RETURN false;
  END IF;

  SELECT p.role, p.status, p.organization_id
    INTO v_role, v_status, v_org
  FROM public.profiles p
  WHERE p.id = p_profile_id;

  -- Rule 1: no such profile.
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Rule 2: suspended/archived profiles authorize nothing, whatever they hold.
  -- Checked BEFORE the super_admin branch: a disabled super_admin is disabled.
  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN false;
  END IF;

  -- Rule 3: an active super_admin is a PLATFORM role. It ignores assignments and
  -- organization scope by design, and no ordinary override can constrain it —
  -- this branch returns before profile_permission_overrides is ever consulted.
  IF v_role = 'super_admin' THEN
    RETURN true;
  END IF;

  -- Rule 7: both resource targets supplied ⇒ fail closed. See the note above.
  IF p_warehouse_id IS NOT NULL AND p_distribution_point_id IS NOT NULL THEN
    RETURN false;
  END IF;

  -- Rule 4: organization isolation. profiles.organization_id is authoritative;
  -- the caller must name it explicitly and it must match. A profile with no
  -- organization (and not super_admin) is not a scoped actor at all.
  IF v_org IS NULL THEN
    RETURN false;
  END IF;
  IF p_organization_id IS NULL OR p_organization_id IS DISTINCT FROM v_org THEN
    RETURN false;
  END IF;

  -- Rule 4: the global permission must be effective. This is the ONLY place the
  -- key itself is evaluated, and it is delegated to the untouched 017 helper —
  -- including its override-then-default-then-false precedence.
  IF NOT phoenix_profile_has_permission(p_profile_id, p_permission_key) THEN
    RETURN false;
  END IF;

  -- Rule 5: warehouse target.
  IF p_warehouse_id IS NOT NULL THEN
    -- The target must belong to the requested (= the profile's) organization.
    IF NOT EXISTS (
      SELECT 1 FROM public.warehouses w
      WHERE w.id = p_warehouse_id
        AND w.organization_id = p_organization_id
        AND w.status = 'active'
    ) THEN
      RETURN false;
    END IF;

    -- Approved legacy oversight/read roles keep organization-wide compatibility.
    IF v_role = ANY (v_org_wide_roles) THEN
      RETURN true;
    END IF;

    -- Everyone else — warehouse_officer included — must be actively assigned.
    RETURN phoenix_profile_has_warehouse_assignment(p_profile_id, p_warehouse_id);
  END IF;

  -- Rule 6: distribution-point target.
  IF p_distribution_point_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.distribution_points d
      WHERE d.id = p_distribution_point_id
        AND d.organization_id = p_organization_id
        AND d.status = 'active'
    ) THEN
      RETURN false;
    END IF;

    IF v_role = ANY (v_org_wide_roles) THEN
      RETURN true;
    END IF;

    RETURN phoenix_profile_has_point_assignment(p_profile_id, p_distribution_point_id);
  END IF;

  -- Rule 8: NULL target semantics. Reaching here means the caller asked an
  -- ORGANIZATION-ONLY question. That is a legitimate question for an oversight or
  -- read role, and it is NEVER a way for an operational role to skip its scope:
  -- omitting the resource must not be more permissive than naming one.
  -- warehouse_officer / port_officer (and their legacy twins) therefore fail
  -- closed here — they are unreachable via this branch, always.
  RETURN v_role = ANY (v_org_wide_roles);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_profile_has_scoped_permission(uuid, text, uuid, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_profile_has_scoped_permission(uuid, text, uuid, uuid, uuid)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_profile_has_scoped_permission(uuid, text, uuid, uuid, uuid) IS
  'Scope-aware permission check: phoenix_profile_has_permission''s answer, '
  'narrowed by organization and active resource assignment. Never broadens it. '
  'Fail-closed on: unknown/inactive profile, missing or mismatched organization, '
  'both resource targets supplied at once, inactive/foreign target, missing '
  'assignment, and an operational role omitting its required resource scope. '
  'super_admin bypasses assignments (platform role). institution_admin, '
  'hospital_admin, monthly_status_officer and viewer keep organization-wide '
  'compatibility. ADDITIVE: phoenix_profile_has_permission(uuid, text) is '
  'unchanged and is called, not reimplemented. Migration 063''s stock and '
  'dispatch RPCs MUST authorize through this function, never through a role literal.';

-- =============================================================================
-- E. Scope-aware SELECT policy replacements
-- =============================================================================
-- Replaces 060's warehouse/stock/movement SELECT policies and 061's dispatch
-- SELECT policies. Every replacement is strictly NARROWER than what it replaces:
-- each keeps the original organization test and the original permission-key test
-- and ADDS a resource-scope test. No policy below can return a row its
-- predecessor would have hidden.
--
-- The org-wide compatibility list is IDENTICAL to the scoped helper's
-- v_org_wide_roles, and deliberately so: two lists would drift, and a policy that
-- disagrees with the helper the RPCs authorize through is a hole by construction.
--
-- 060's wh_insert_perm / wh_update_perm are NOT replaced — see the header. There
-- is still no DELETE policy anywhere in this domain: retirement stays
-- archive-based.

-- ─────────────────────────────────────────────────────────────────────────────
-- E1. warehouses — master records
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "wh_select_perm" ON public.warehouses;

CREATE POLICY "wh_select_scoped" ON public.warehouses
  FOR SELECT TO authenticated
  USING (
    -- super_admin: all organizations.
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouses.view')
      AND (
        -- institution_admin / hospital_admin / monthly_status_officer / viewer:
        -- organization-wide compatibility (viewer read-only — it holds no
        -- warehouse write key; monthly_status_officer holds no warehouse key at
        -- all, so this branch grants it nothing today and is listed only to keep
        -- one canonical role list).
        phoenix_my_role() IN ('institution_admin','hospital_admin','monthly_status_officer','viewer')
        -- warehouse_officer: ONLY its actively assigned warehouses.
        OR phoenix_profile_has_warehouse_assignment(auth.uid(), id)
        -- port_officer: no warehouse-master visibility in general. The ONE
        -- exception is the named dispatch context — a warehouse that has actually
        -- dispatched to an outlet this officer is actively assigned to. Without
        -- it the outlet UI cannot name the sender of a shipment it is being asked
        -- to accept. It is bounded by a real dispatch row, not by the org.
        OR (
          phoenix_my_role() = 'port_officer'
          AND phoenix_profile_has_permission(auth.uid(), 'warehouse_dispatch.view')
          AND EXISTS (
            SELECT 1 FROM public.warehouse_dispatches d
            WHERE d.warehouse_id     = warehouses.id
              AND d.organization_id  = warehouses.organization_id
              AND phoenix_profile_has_point_assignment(auth.uid(), d.destination_distribution_point_id)
          )
        )
      )
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- E2. warehouse_stock
-- ─────────────────────────────────────────────────────────────────────────────
-- Note the key change: 060 gated stock visibility on `warehouses.view`, which is
-- why removing warehouses.manage alone would not have been enough — stock is now
-- gated on its own `warehouse_stock.view` key, which port_officer is explicitly
-- denied in part C. port_officer is therefore denied twice over (no key, and no
-- warehouse assignment), which is the intent: an outlet officer has no business
-- reading warehouse quantities.
DROP POLICY IF EXISTS "warehouse_stock_select_perm" ON public.warehouse_stock;

CREATE POLICY "warehouse_stock_select_scoped" ON public.warehouse_stock
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouse_stock.view')
      AND (
        phoenix_my_role() IN ('institution_admin','hospital_admin','monthly_status_officer','viewer')
        OR phoenix_profile_has_warehouse_assignment(auth.uid(), warehouse_id)
      )
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- E3. warehouse_stock_movements
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "warehouse_stock_mov_select_perm" ON public.warehouse_stock_movements;

CREATE POLICY "warehouse_stock_mov_select_scoped" ON public.warehouse_stock_movements
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouse_stock.movements_view')
      AND (
        phoenix_my_role() IN ('institution_admin','hospital_admin','monthly_status_officer','viewer')
        OR phoenix_profile_has_warehouse_assignment(auth.uid(), warehouse_id)
      )
    )
  );

-- Still no INSERT/UPDATE/DELETE policy on warehouse_stock or
-- warehouse_stock_movements, and no write grant — unchanged from 060. Direct
-- stock writes remain impossible; migration 063's SECURITY DEFINER stock RPCs
-- are the only write path and MUST authorize through
-- phoenix_profile_has_scoped_permission(..., p_warehouse_id => <the warehouse>).

-- ─────────────────────────────────────────────────────────────────────────────
-- E4. warehouse_dispatches — header
-- ─────────────────────────────────────────────────────────────────────────────
-- This replaces the org-scoped policy 061 shipped as an explicit placeholder:
-- 061's own comment says outlet-level narrowing was "deliberately NOT attempted
-- here: no assigned-distribution-point model exists in this schema". Part A of
-- this migration is that model, so the narrowing lands now.
DROP POLICY IF EXISTS "warehouse_dispatches_select_perm" ON public.warehouse_dispatches;

CREATE POLICY "warehouse_dispatches_select_scoped" ON public.warehouse_dispatches
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouse_dispatch.view')
      AND (
        phoenix_my_role() IN ('institution_admin','hospital_admin','monthly_status_officer','viewer')
        -- The sending side sees dispatches FROM warehouses it is assigned to.
        OR (
          phoenix_my_role() = 'warehouse_officer'
          AND phoenix_profile_has_warehouse_assignment(auth.uid(), warehouse_id)
        )
        -- The receiving side sees dispatches TO outlets it is assigned to.
        OR (
          phoenix_my_role() = 'port_officer'
          AND phoenix_profile_has_point_assignment(auth.uid(), destination_distribution_point_id)
        )
      )
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- E5. warehouse_dispatch_lines — derived through the header, never trusted alone
-- ─────────────────────────────────────────────────────────────────────────────
-- The line policy MUST NOT authorize on warehouse_dispatch_lines.organization_id.
-- That column exists to serve the composite FKs (061), not to answer "may you see
-- this?". Trusting it would mean a line is visible on the strength of a column
-- that no longer proves which dispatch it belongs to — and the line carries the
-- material identity, quantity and price, i.e. exactly the payload the header's
-- scoping exists to protect. Visibility is therefore derived from the header row,
-- with the SAME predicate as E4, so the two can never disagree.
DROP POLICY IF EXISTS "warehouse_dispatch_lines_select_perm" ON public.warehouse_dispatch_lines;

CREATE POLICY "warehouse_dispatch_lines_select_scoped" ON public.warehouse_dispatch_lines
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.warehouse_dispatches d
      WHERE d.id = warehouse_dispatch_lines.dispatch_id
        AND (
          phoenix_my_role() = 'super_admin'
          OR (
            d.organization_id = phoenix_my_org()
            AND phoenix_profile_has_permission(auth.uid(), 'warehouse_dispatch.view')
            AND (
              phoenix_my_role() IN ('institution_admin','hospital_admin','monthly_status_officer','viewer')
              OR (
                phoenix_my_role() = 'warehouse_officer'
                AND phoenix_profile_has_warehouse_assignment(auth.uid(), d.warehouse_id)
              )
              OR (
                phoenix_my_role() = 'port_officer'
                AND phoenix_profile_has_point_assignment(auth.uid(), d.destination_distribution_point_id)
              )
            )
          )
        )
    )
  );

-- Still no INSERT/UPDATE/DELETE policy and no write grant on either dispatch
-- table — unchanged from 061. anon holds nothing on any table touched here.

-- =============================================================================
-- F. Last super-admin protection
-- =============================================================================
-- WHY THIS MUST BE IN THE DATABASE — READ BEFORE EDITING.
--
-- The Edge Function admin-user-lifecycle already refuses to disable or delete the
-- last active super_admin (its LAST_SUPER_ADMIN check). That check is necessary
-- but demonstrably not sufficient, on four independent counts:
--
--   1. It is one code path. Any other path — the SQL Editor, a psql session, a
--      service_role script, a future RPC, assign_profile_role (005) — reaches
--      profiles directly and never consults it.
--   2. It does not cover DEMOTION at all. `role = 'viewer'` on the last
--      super_admin locks the platform out just as completely as a delete, and no
--      existing check stops it.
--   3. profiles.id REFERENCES auth.users(id) ON DELETE CASCADE (001). Deleting
--      the AUTH user — a different table, a different API, a different Supabase
--      dashboard screen — cascades into profiles without the Edge Function being
--      involved. This trigger fires on that cascade.
--   4. It is racy. Two administrators each disabling the other's super_admin
--      account simultaneously both read "one other remains" and both succeed,
--      leaving zero. See the advisory lock below.
--
-- Losing every active super_admin is unrecoverable through the product: there is
-- no path left that can create one. So this is fail-closed, in the database,
-- covering every write path including service_role.
--
-- The Edge Function's own check is deliberately NOT modified by this migration —
-- it still gives a clean early error for the common case. Migration 063 maps this
-- trigger's LAST_SUPER_ADMIN_PROTECTED token onto that same user-facing message.

CREATE OR REPLACE FUNCTION public.phoenix_protect_last_super_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_delete       boolean := (TG_OP = 'DELETE');
  v_loses_admin     boolean;
  v_scopes_admin    boolean;
  v_other_admins    int;
  v_other_global    int;
BEGIN
  -- Only rows that are RIGHT NOW an active super_admin are protected. Every
  -- other profile update/delete in the system falls straight through here, takes
  -- no lock, and runs exactly as it did before this migration.
  IF OLD.role IS DISTINCT FROM 'super_admin' OR OLD.status IS DISTINCT FROM 'active' THEN
    IF v_is_delete THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- The three ways an active super_admin stops being one:
  --   deleted, demoted (role away), or disabled (status away).
  v_loses_admin := v_is_delete
    OR NEW.role   IS DISTINCT FROM 'super_admin'
    OR NEW.status IS DISTINCT FROM 'active';

  -- ...and the fourth, subtler one: narrowing a GLOBAL platform admin to a single
  -- organization. It keeps the role and the status, so the count above still says
  -- "one active super_admin exists" — while nobody is left who can administer the
  -- platform across organizations.
  --
  -- Note the precise direction: NULL → NOT NULL only. Un-scoping (NOT NULL →
  -- NULL) makes an admin MORE global and is always allowed, and an already-scoped
  -- admin can be moved between organizations freely. This asymmetry is what keeps
  -- the rule from fail-shutting on a database whose only super_admin already
  -- carries an organization_id — a state this migration must tolerate, since it
  -- may not connect to the database to find out.
  v_scopes_admin := (NOT v_is_delete)
    AND OLD.organization_id IS NULL
    AND NEW.organization_id IS NOT NULL;

  -- An ordinary edit to a super_admin row (name, phone, whatsapp, updated_at):
  -- untouched, and — importantly — it takes no advisory lock, so routine profile
  -- writes never serialize against each other.
  IF NOT v_loses_admin AND NOT v_scopes_admin THEN
    RETURN NEW;
  END IF;

  -- ───────────────────────────────────────────────────────────────────────────
  -- The lock. Without it this trigger is decorative under concurrency.
  -- ───────────────────────────────────────────────────────────────────────────
  -- Two concurrent transactions, each demoting one of the last two super_admins,
  -- would each COUNT the other's still-committed row, each conclude "one other
  -- remains", and both commit — leaving zero. Neither transaction sees the
  -- other's uncommitted change, so no amount of re-reading fixes it: READ
  -- COMMITTED simply does not serialize this.
  --
  -- pg_advisory_xact_lock forces the second transaction to WAIT until the first
  -- commits or rolls back, so its count reflects reality. Transaction-scoped
  -- (_xact_), so it is released automatically on commit AND on rollback — there
  -- is no unlock path to forget, and no way to leak the lock on an error.
  --
  -- The key is a stable application-specific constant, chosen once for this
  -- project and never reused: 778062062. Any code that ever needs to serialize
  -- against last-super-admin evaluation must use this exact number.
  PERFORM pg_advisory_xact_lock(778062062);

  IF v_loses_admin THEN
    SELECT count(*) INTO v_other_admins
    FROM public.profiles p
    WHERE p.id <> OLD.id
      AND p.role   = 'super_admin'
      AND p.status = 'active';

    -- `< 1`, so exactly ONE remaining active super_admin is a valid, fully
    -- supported state — this trigger protects that account, it does not demand a
    -- second one. (A backup super_admin is operationally recommended; the
    -- database does not require it and this migration does not create one.)
    IF v_other_admins < 1 THEN
      RAISE EXCEPTION 'LAST_SUPER_ADMIN_PROTECTED: profile % is the last active super_admin and cannot be deleted, disabled or demoted', OLD.id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_scopes_admin THEN
    SELECT count(*) INTO v_other_global
    FROM public.profiles p
    WHERE p.id <> OLD.id
      AND p.role   = 'super_admin'
      AND p.status = 'active'
      AND p.organization_id IS NULL;

    IF v_other_global < 1 THEN
      RAISE EXCEPTION 'LAST_SUPER_ADMIN_PROTECTED: profile % is the last active platform-global super_admin and cannot be scoped to organization %', OLD.id, NEW.organization_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_is_delete THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- BEFORE, not AFTER: the write must be prevented, not observed after the fact.
-- FOR EACH ROW: a statement-level trigger has no OLD to test.
DROP TRIGGER IF EXISTS trg_protect_last_super_admin ON public.profiles;
CREATE TRIGGER trg_protect_last_super_admin
  BEFORE UPDATE OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_protect_last_super_admin();

COMMENT ON FUNCTION public.phoenix_protect_last_super_admin() IS
  'Fail-closed protection of the final active super_admin against deletion '
  '(including the auth.users ON DELETE CASCADE path), disabling, demotion, and '
  'narrowing the last platform-global admin to one organization. Serializes '
  'concurrent evaluations with pg_advisory_xact_lock(778062062) so two '
  'administrators cannot leave zero. Raises the stable machine-readable token '
  'LAST_SUPER_ADMIN_PROTECTED (SQLSTATE 42501) — migration 063 maps it to a '
  'user-facing message; do not change the token. Applies to every write path '
  'including service_role: only a superuser could disable this trigger, and '
  'service_role is not one. Exactly one active super_admin is a valid state.';

-- =============================================================================
-- G. profile_permission_overrides safety (PRIMARY KEY UNCHANGED)
-- =============================================================================
-- The three-state model is PRESERVED exactly as migrations 010/017 defined it:
--   • no row, or allowed IS NULL  ⇒ inherited from role_permission_defaults
--   • allowed = true              ⇒ explicit allow
--   • allowed = false             ⇒ explicit deny
-- Nothing here writes, copies or reinterprets a row: role defaults are NEVER
-- materialized into overrides, and the PK stays (profile_id, permission_key).
--
-- What IS added: the scope columns 010 created have never had a single rule.
-- Today a row can name a warehouse AND an outlet at once, or name a warehouse
-- belonging to a different organization than its own scope_organization_id, or
-- scope a user's override to an organization that is not the user's. Nothing has
-- read those columns yet, so nothing has broken — but 063's user-management UI is
-- about to start writing them, and unconstrained scope columns feeding an
-- authorization decision is exactly how a cross-org escalation gets built.
--
-- APPLY-TIME READINESS: this migration may not connect to the database, so it
-- cannot know whether live rows already violate these rules. Each constraint is
-- therefore preceded by a PRECHECK that proves it against real data and fails the
-- whole transaction with an actionable message if it does not hold. That is
-- fail-closed: a violating database rolls 062 back completely rather than
-- applying half a rule set. Expected in practice: zero violations, because no
-- code path has ever written these columns.

-- G1. PRECHECK — at most one resource scope column populated.
DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
  FROM public.profile_permission_overrides
  WHERE num_nonnulls(scope_warehouse_id, scope_point_id) > 1;

  ASSERT v_bad = 0,
    'VERIFY FAILED (062 precheck): ' || v_bad || ' profile_permission_overrides row(s) name '
    'both a warehouse and a distribution point. Migration 062 has rolled back and no constraint '
    'was added. Resolve those rows (each override may name at most one resource) and re-apply.';
END $$;

-- G2. PRECHECK — a scoped resource must belong to scope_organization_id.
DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
  FROM public.profile_permission_overrides o
  WHERE (
      o.scope_warehouse_id IS NOT NULL
      AND o.scope_organization_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.warehouses w
        WHERE w.id = o.scope_warehouse_id AND w.organization_id = o.scope_organization_id
      )
    )
    OR (
      o.scope_point_id IS NOT NULL
      AND o.scope_organization_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.distribution_points d
        WHERE d.id = o.scope_point_id AND d.organization_id = o.scope_organization_id
      )
    );

  ASSERT v_bad = 0,
    'VERIFY FAILED (062 precheck): ' || v_bad || ' profile_permission_overrides row(s) scope a '
    'resource that does not belong to their scope_organization_id. Migration 062 has rolled back '
    'and no constraint was added. Resolve those rows and re-apply.';
END $$;

-- G3. PRECHECK — no non-super-admin override may cross its profile's org.
DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
  FROM public.profile_permission_overrides o
  JOIN public.profiles p ON p.id = o.profile_id
  WHERE o.scope_organization_id IS NOT NULL
    AND p.role <> 'super_admin'
    AND o.scope_organization_id IS DISTINCT FROM p.organization_id;

  ASSERT v_bad = 0,
    'VERIFY FAILED (062 precheck): ' || v_bad || ' profile_permission_overrides row(s) scope a '
    'non-super_admin profile to an organization other than its own. Migration 062 has rolled back '
    'and no trigger was added. Resolve those rows and re-apply.';
END $$;

-- At most one resource scope column populated. A row naming both is
-- uninterpretable — every reader would have to guess which one wins, and two
-- readers guessing differently is a hole.
DO $$ BEGIN
  ALTER TABLE public.profile_permission_overrides
    ADD CONSTRAINT ppo_single_resource_scope_chk
    CHECK (num_nonnulls(scope_warehouse_id, scope_point_id) <= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Structural org pinning of the scoped resource, same composite-FK technique as
-- 060/061 and part A. MATCH SIMPLE is required: when scope_organization_id is
-- NULL (an unscoped override — the shape 017's assign_profile_permissions writes,
-- and the overwhelming majority of live rows) the FK is not enforced at all,
-- which is exactly right. It constrains only rows that actually claim a scope.
DO $$ BEGIN
  ALTER TABLE public.profile_permission_overrides
    ADD CONSTRAINT ppo_scope_warehouse_org_fk
    FOREIGN KEY (scope_warehouse_id, scope_organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.profile_permission_overrides
    ADD CONSTRAINT ppo_scope_point_org_fk
    FOREIGN KEY (scope_point_id, scope_organization_id)
    REFERENCES public.distribution_points (id, organization_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The org-crossing rule needs a trigger for the same reason part A did: it is an
-- equality between two different parents (the override's scope and the PROFILE's
-- org), which no foreign key can express.
CREATE OR REPLACE FUNCTION public.phoenix_validate_ppo_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_org  uuid;
BEGIN
  -- Unscoped override (the common case, and everything 017 writes): nothing to
  -- validate — the global helper ignores scope entirely.
  IF NEW.scope_organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.role, p.organization_id INTO v_role, v_org
  FROM public.profiles p
  WHERE p.id = NEW.profile_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PPO_SCOPE_PROFILE_NOT_FOUND: profile % does not exist', NEW.profile_id
      USING ERRCODE = '23503';
  END IF;

  -- super_admin is a platform role: an org-scoped override on it is a deliberate
  -- narrowing, not an escalation, so it is left alone.
  IF v_role = 'super_admin' THEN
    RETURN NEW;
  END IF;

  IF NEW.scope_organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'PPO_SCOPE_ORG_MISMATCH: override for profile % cannot be scoped to organization % (profile organization is %)',
      NEW.profile_id, NEW.scope_organization_id, v_org
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_ppo_scope ON public.profile_permission_overrides;
CREATE TRIGGER trg_validate_ppo_scope
  BEFORE INSERT OR UPDATE ON public.profile_permission_overrides
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_validate_ppo_scope();

COMMENT ON FUNCTION public.phoenix_validate_ppo_scope() IS
  'Fail-closed: a non-super_admin profile''s permission override can never be '
  'scoped outside profiles.organization_id. Unscoped overrides (scope_organization_id '
  'IS NULL — everything assign_profile_permissions writes) are unaffected, so the '
  'three-state inherited/allow/deny model and migration 017''s RPCs are untouched.';

COMMENT ON TABLE public.profile_permission_overrides IS
  'Per-profile permission opinions, three-state: no row or allowed IS NULL = '
  'inherit the role default; true = explicit allow; false = explicit deny. '
  'PRIMARY KEY (profile_id, permission_key) — one opinion per key per profile. '
  'This table is NOT an assignment ledger: warehouse/outlet responsibility lives '
  'in profile_scope_assignments (062), because this PK permits only one scoped '
  'row per key and carries no revocation history. Role defaults are never copied '
  'into this table.';

-- =============================================================================
-- H. VERIFY — runs INSIDE this transaction; any failure rolls everything back
-- =============================================================================
-- There is deliberately NO exception handler anywhere in this block. A swallowed
-- assertion is worse than no assertion: it reports success while the contract it
-- was written to prove is broken.
DO $$
DECLARE
  v_cnt      int;
  v_txt      text;
  v_src      text;
  v_item     text;
  v_qual     text;
  v_expected text;
BEGIN
  -- ===========================================================================
  -- 1. Prerequisites: 060 + 061 must already be applied
  -- ===========================================================================
  FOREACH v_item IN ARRAY ARRAY[
    'warehouses','warehouse_stock','warehouse_stock_movements',
    'warehouse_dispatches','warehouse_dispatch_lines',
    'profiles','permission_keys','role_permission_defaults','profile_permission_overrides',
    'organizations','distribution_points','audit_logs'
  ] LOOP
    ASSERT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = v_item
    ), 'VERIFY FAILED (062): required table missing: ' || v_item ||
       ' — migrations 001–061 must all be applied before 062';
  END LOOP;

  -- The composite FK targets 062 depends on (060 and 061 respectively).
  FOREACH v_item IN ARRAY ARRAY[
    'warehouses_id_org_uniq',            -- 060
    'distribution_points_id_org_uniq',   -- 061
    'warehouse_stock_id_org_uniq'        -- 061
  ] LOOP
    ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_item),
      'VERIFY FAILED (062): composite FK target missing: ' || v_item ||
      ' — migration 061 must be applied before 062';
  END LOOP;

  -- 061's identity + retention contracts must still be present and intact.
  ASSERT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
    AND indexname = 'item_availability_dp_sci_conc_form_nat_batch_exp_ibr_uniq'),
    'VERIFY FAILED (062): 061 8-field outlet identity index missing — 062 must not disturb it';
  ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_dispatch_lines_decision_chk'),
    'VERIFY FAILED (062): 061 dispatch decision CHECK missing';
  SELECT pg_get_constraintdef(oid) INTO v_txt FROM pg_constraint
  WHERE conname = 'warehouse_dispatch_lines_decision_chk';
  -- 061's retention fix: no nullable FK may be required non-null. If 062 somehow
  -- disturbed it, Deep Clean and actor deletion would break.
  FOREACH v_item IN ARRAY ARRAY[
    'accepted_by IS NOT NULL','rejected_by IS NOT NULL',
    'resulting_item_availability_id IS NOT NULL','resulting_movement_id IS NOT NULL'
  ] LOOP
    ASSERT v_txt NOT LIKE '%' || v_item || '%',
      'VERIFY FAILED (062): 061 retention contract broken — decision CHECK now requires ' || v_item;
  END LOOP;

  ASSERT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
    AND indexname = 'item_availability_movements_dispatch_line_uniq'),
    'VERIFY FAILED (062): 061 acceptance idempotency index missing';
  ASSERT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
    AND indexname = 'warehouse_stock_identity_uniq'),
    'VERIFY FAILED (062): 060 warehouse stock identity index missing';

  -- ===========================================================================
  -- 2. profile_scope_assignments — schema
  -- ===========================================================================
  ASSERT EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'profile_scope_assignments'),
    'VERIFY FAILED (062): profile_scope_assignments missing';

  -- Exact column set: 14 columns, no more (an extra column here would mean a
  -- second, competing assignment model crept in).
  SELECT count(*) INTO v_cnt FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'profile_scope_assignments';
  ASSERT v_cnt = 14,
    'VERIFY FAILED (062): profile_scope_assignments should have exactly 14 columns, found ' || v_cnt;

  FOREACH v_item IN ARRAY ARRAY[
    'id','profile_id','organization_id','scope_type','warehouse_id','distribution_point_id',
    'is_active','assigned_by','assigned_at','revoked_by','revoked_at','revoke_reason',
    'created_at','updated_at'
  ] LOOP
    ASSERT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profile_scope_assignments'
        AND column_name = v_item
    ), 'VERIFY FAILED (062): profile_scope_assignments column missing: ' || v_item;
  END LOOP;

  -- NOT NULL where the contract requires it.
  FOREACH v_item IN ARRAY ARRAY[
    'id','profile_id','organization_id','scope_type','is_active','assigned_at','created_at','updated_at'
  ] LOOP
    ASSERT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profile_scope_assignments'
        AND column_name = v_item AND is_nullable = 'NO'
    ), 'VERIFY FAILED (062): profile_scope_assignments.' || v_item || ' must be NOT NULL';
  END LOOP;

  -- Nullable where retention requires it — revoked_by MUST stay nullable, or the
  -- ON DELETE SET NULL that keeps a revoker deletable would fight a NOT NULL.
  FOREACH v_item IN ARRAY ARRAY[
    'warehouse_id','distribution_point_id','assigned_by','revoked_by','revoked_at','revoke_reason'
  ] LOOP
    ASSERT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profile_scope_assignments'
        AND column_name = v_item AND is_nullable = 'YES'
    ), 'VERIFY FAILED (062): profile_scope_assignments.' || v_item || ' must be nullable';
  END LOOP;

  -- scope_type is text + CHECK, never an enum.
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profile_scope_assignments'
      AND column_name = 'scope_type' AND data_type = 'text'
  ), 'VERIFY FAILED (062): scope_type must be text (not an enum)';

  SELECT pg_get_constraintdef(oid) INTO v_txt FROM pg_constraint WHERE conname = 'psa_scope_type_chk';
  ASSERT v_txt IS NOT NULL, 'VERIFY FAILED (062): psa_scope_type_chk missing';
  ASSERT v_txt LIKE '%warehouse%' AND v_txt LIKE '%distribution_point%',
    'VERIFY FAILED (062): psa_scope_type_chk does not enumerate both scope values';

  -- ===========================================================================
  -- 3. profile_scope_assignments — constraints and indexes
  -- ===========================================================================
  FOREACH v_item IN ARRAY ARRAY[
    'psa_warehouse_org_fk','psa_point_org_fk','psa_scope_type_chk',
    'psa_target_matches_scope_chk','psa_status_chk','psa_revoke_reason_chk',
    'psa_revoked_after_assigned_chk'
  ] LOOP
    ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_item),
      'VERIFY FAILED (062): profile_scope_assignments constraint missing: ' || v_item;
  END LOOP;

  -- The warehouse/outlet target invariants.
  SELECT pg_get_constraintdef(oid) INTO v_txt FROM pg_constraint
  WHERE conname = 'psa_target_matches_scope_chk';
  ASSERT v_txt LIKE '%warehouse_id IS NOT NULL%' AND v_txt LIKE '%distribution_point_id IS NULL%',
    'VERIFY FAILED (062): warehouse assignment invariant missing from psa_target_matches_scope_chk';
  ASSERT v_txt LIKE '%distribution_point_id IS NOT NULL%' AND v_txt LIKE '%warehouse_id IS NULL%',
    'VERIFY FAILED (062): outlet assignment invariant missing from psa_target_matches_scope_chk';

  -- The revocation invariants, and the retention rule that revoked_by is NOT
  -- required to stay non-null.
  SELECT pg_get_constraintdef(oid) INTO v_txt FROM pg_constraint WHERE conname = 'psa_status_chk';
  ASSERT v_txt LIKE '%revoked_at IS NOT NULL%',
    'VERIFY FAILED (062): psa_status_chk must require revoked_at on a revoked row';
  ASSERT v_txt LIKE '%btrim(revoke_reason)%',
    'VERIFY FAILED (062): psa_status_chk must require a trimmed non-empty revoke_reason';
  ASSERT v_txt NOT LIKE '%revoked_by IS NOT NULL%',
    'VERIFY FAILED (062): psa_status_chk must NOT require revoked_by non-null — it is '
    'ON DELETE SET NULL, and such a rule would make any revoker permanently undeletable '
    '(the retention bug migration 061 already fixed once)';

  -- Active-assignment uniqueness: partial, so revoked history and multiple
  -- distinct targets both stay legal.
  FOREACH v_item IN ARRAY ARRAY['psa_active_warehouse_uniq','psa_active_point_uniq'] LOOP
    ASSERT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = v_item),
      'VERIFY FAILED (062): active-assignment unique index missing: ' || v_item;

    SELECT indexdef INTO v_txt FROM pg_indexes WHERE schemaname = 'public' AND indexname = v_item;
    ASSERT v_txt ILIKE '%UNIQUE%',
      'VERIFY FAILED (062): ' || v_item || ' is not UNIQUE';
    ASSERT v_txt ILIKE '%WHERE%is_active%',
      'VERIFY FAILED (062): ' || v_item || ' must be PARTIAL on is_active — a total unique index '
      'would destroy revoked history and forbid re-assignment';
    ASSERT v_txt ILIKE '%profile_id%',
      'VERIFY FAILED (062): ' || v_item || ' must be keyed per profile';
  END LOOP;

  -- Uniqueness must be per (profile, target) — NOT per profile alone, or one
  -- officer could never hold two different warehouses/outlets.
  SELECT indexdef INTO v_txt FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'psa_active_warehouse_uniq';
  ASSERT v_txt ILIKE '%warehouse_id%',
    'VERIFY FAILED (062): psa_active_warehouse_uniq must include warehouse_id — otherwise a '
    'profile could hold only ONE active warehouse, breaking multi-warehouse assignment';
  SELECT indexdef INTO v_txt FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'psa_active_point_uniq';
  ASSERT v_txt ILIKE '%distribution_point_id%',
    'VERIFY FAILED (062): psa_active_point_uniq must include distribution_point_id';

  -- Structural org pinning of both targets, with the correct delete actions.
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname = 'psa_warehouse_org_fk' AND c.contype = 'f'
      AND c.confrelid = 'public.warehouses'::regclass
      AND c.confdeltype = 'r'
  ), 'VERIFY FAILED (062): psa_warehouse_org_fk must reference warehouses ON DELETE RESTRICT';

  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname = 'psa_point_org_fk' AND c.contype = 'f'
      AND c.confrelid = 'public.distribution_points'::regclass
      AND c.confdeltype = 'r'
  ), 'VERIFY FAILED (062): psa_point_org_fk must reference distribution_points ON DELETE RESTRICT';

  -- Both composite FKs must be TWO-column, or they pin nothing.
  FOREACH v_item IN ARRAY ARRAY['psa_warehouse_org_fk','psa_point_org_fk'] LOOP
    SELECT pg_get_constraintdef(oid) INTO v_txt FROM pg_constraint WHERE conname = v_item;
    ASSERT v_txt LIKE '%organization_id%',
      'VERIFY FAILED (062): ' || v_item || ' must be composite on organization_id — a single-column '
      'FK would let a resource from another organization be assigned';
  END LOOP;

  -- profile_id cascades (a deleted person leaves no dangling assignment); the
  -- actor columns are retention-soft.
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.profile_scope_assignments'::regclass AND c.contype = 'f'
      AND c.confrelid = 'public.profiles'::regclass AND c.confdeltype = 'c'
  ), 'VERIFY FAILED (062): profile_scope_assignments.profile_id must be ON DELETE CASCADE';

  SELECT count(*) INTO v_cnt
  FROM pg_constraint c
  WHERE c.conrelid = 'public.profile_scope_assignments'::regclass AND c.contype = 'f'
    AND c.confrelid = 'auth.users'::regclass AND c.confdeltype = 'n';
  ASSERT v_cnt = 2,
    'VERIFY FAILED (062): assigned_by and revoked_by must both be ON DELETE SET NULL (actor '
    'retention), found ' || v_cnt || ' such FK(s)';

  -- Organization is retention-safe (RESTRICT), never CASCADE.
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.profile_scope_assignments'::regclass AND c.contype = 'f'
      AND c.confrelid = 'public.organizations'::regclass AND c.confdeltype = 'r'
  ), 'VERIFY FAILED (062): profile_scope_assignments.organization_id must be ON DELETE RESTRICT';

  -- ===========================================================================
  -- 4. Assignment validation trigger — same-org + live-target, fail-closed
  -- ===========================================================================
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.profile_scope_assignments'::regclass
      AND t.tgname = 'trg_validate_profile_scope_assignment'
      AND NOT t.tgisinternal
  ), 'VERIFY FAILED (062): trg_validate_profile_scope_assignment missing';

  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_validate_profile_scope_assignment';
  ASSERT v_src IS NOT NULL,
    'VERIFY FAILED (062): phoenix_validate_profile_scope_assignment missing';
  ASSERT v_src LIKE '%SCOPE_ASSIGNMENT_ORG_MISMATCH%',
    'VERIFY FAILED (062): assignment trigger lost its profile-organization enforcement';
  ASSERT v_src LIKE '%SCOPE_ASSIGNMENT_TARGET_INACTIVE%',
    'VERIFY FAILED (062): assignment trigger lost its archived/inactive target denial';
  ASSERT v_src LIKE '%SCOPE_ASSIGNMENT_TARGET_NOT_FOUND%',
    'VERIFY FAILED (062): assignment trigger lost its missing-target denial';
  -- Fail-closed: no swallowing handler anywhere in the validator.
  ASSERT v_src NOT ILIKE '%EXCEPTION WHEN OTHERS%',
    'VERIFY FAILED (062): assignment trigger contains a swallowing exception handler';

  -- ===========================================================================
  -- 5. New permission keys — all ten, exactly
  -- ===========================================================================
  FOREACH v_item IN ARRAY ARRAY[
    'users.edit_scope','users.reset_permissions',
    'warehouse_stock.view','warehouse_stock.adjust','warehouse_stock.correct',
    'warehouse_stock.movements_view',
    'reports.view','reports.financial','reports.export',
    'audit.view'
  ] LOOP
    ASSERT EXISTS (SELECT 1 FROM public.permission_keys WHERE key = v_item),
      'VERIFY FAILED (062): permission key missing: ' || v_item;

    -- Labels in both languages, per the 010 contract.
    ASSERT EXISTS (
      SELECT 1 FROM public.permission_keys
      WHERE key = v_item AND btrim(label_en) <> '' AND btrim(label_ar) <> ''
    ), 'VERIFY FAILED (062): permission key ' || v_item || ' lacks an English/Arabic label';
  END LOOP;

  -- No duplicate key rows (the PK guarantees it; asserted so a future edit that
  -- re-seeds an existing key with different metadata is caught here).
  SELECT count(*) INTO v_cnt FROM public.permission_keys
  WHERE key IN (
    'users.edit_scope','users.reset_permissions','warehouse_stock.view','warehouse_stock.adjust',
    'warehouse_stock.correct','warehouse_stock.movements_view','reports.view','reports.financial',
    'reports.export','audit.view'
  );
  ASSERT v_cnt = 10,
    'VERIFY FAILED (062): expected exactly 10 new permission keys, found ' || v_cnt;

  -- The keys 060/061 depend on must still exist and be untouched.
  SELECT count(*) INTO v_cnt FROM public.permission_keys
  WHERE key IN ('warehouses.view','warehouses.manage')
     OR key LIKE 'warehouse_dispatch.%';
  ASSERT v_cnt = 10,
    'VERIFY FAILED (062): the 060/061 permission keys (2 + 8) must remain intact, found ' || v_cnt;

  -- ===========================================================================
  -- 6. Role defaults — the exact corrections
  -- ===========================================================================
  -- The correction this whole migration turns on.
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.role_permission_defaults
    WHERE role = 'warehouse_officer' AND permission_key = 'warehouses.manage' AND allowed = true
  ), 'VERIFY FAILED (062): warehouse_officer still holds warehouses.manage by default — a Warehouse '
     'Data Entry Officer must not be able to create, rename, re-code, re-main or archive warehouse '
     'master records';

  ASSERT EXISTS (
    SELECT 1 FROM public.role_permission_defaults
    WHERE role = 'warehouse_officer' AND permission_key = 'warehouses.manage' AND allowed = false
  ), 'VERIFY FAILED (062): the warehouse_officer/warehouses.manage deny row is missing — the deny '
     'must be explicit so a re-run of 010''s seed cannot silently reinstate the grant';

  -- warehouse_officer keeps the ability to SEE its warehouses.
  ASSERT EXISTS (
    SELECT 1 FROM public.role_permission_defaults
    WHERE role = 'warehouse_officer' AND permission_key = 'warehouses.view' AND allowed = true
  ), 'VERIFY FAILED (062): warehouse_officer lost warehouses.view';

  -- warehouse_officer's stock package.
  FOREACH v_item IN ARRAY ARRAY[
    'warehouse_stock.view','warehouse_stock.adjust','warehouse_stock.correct',
    'warehouse_stock.movements_view','reports.view','audit.view'
  ] LOOP
    ASSERT EXISTS (
      SELECT 1 FROM public.role_permission_defaults
      WHERE role = 'warehouse_officer' AND permission_key = v_item AND allowed = true
    ), 'VERIFY FAILED (062): warehouse_officer must hold ' || v_item;
  END LOOP;

  -- Separation of duty: the sender must never decide acceptance.
  FOREACH v_item IN ARRAY ARRAY['warehouse_dispatch.accept','warehouse_dispatch.reject'] LOOP
    ASSERT NOT EXISTS (
      SELECT 1 FROM public.role_permission_defaults
      WHERE role = 'warehouse_officer' AND permission_key = v_item AND allowed = true
    ), 'VERIFY FAILED (062): warehouse_officer must never hold ' || v_item ||
       ' — a sender that can self-accept injects stock into an outlet with nobody at the outlet '
       'confirming receipt';
  END LOOP;

  -- warehouse_officer denials.
  FOREACH v_item IN ARRAY ARRAY[
    'reports.financial','reports.export','users.edit_scope','users.reset_permissions'
  ] LOOP
    ASSERT NOT EXISTS (
      SELECT 1 FROM public.role_permission_defaults
      WHERE role = 'warehouse_officer' AND permission_key = v_item AND allowed = true
    ), 'VERIFY FAILED (062): warehouse_officer must not hold ' || v_item || ' by default';
  END LOOP;

  -- No users.* default for warehouse_officer at all.
  SELECT count(*) INTO v_cnt FROM public.role_permission_defaults
  WHERE role = 'warehouse_officer' AND permission_key LIKE 'users.%' AND allowed = true;
  ASSERT v_cnt = 0,
    'VERIFY FAILED (062): warehouse_officer holds ' || v_cnt || ' users.* permission(s) by default';

  -- port_officer: no warehouse stock authority whatsoever.
  FOREACH v_item IN ARRAY ARRAY[
    'warehouse_stock.view','warehouse_stock.adjust','warehouse_stock.correct',
    'warehouse_stock.movements_view','warehouses.manage'
  ] LOOP
    ASSERT NOT EXISTS (
      SELECT 1 FROM public.role_permission_defaults
      WHERE role = 'port_officer' AND permission_key = v_item AND allowed = true
    ), 'VERIFY FAILED (062): port_officer must not hold ' || v_item;

    ASSERT EXISTS (
      SELECT 1 FROM public.role_permission_defaults
      WHERE role = 'port_officer' AND permission_key = v_item AND allowed = false
    ), 'VERIFY FAILED (062): port_officer''s deny of ' || v_item || ' must be explicit';
  END LOOP;

  -- port_officer: receiving side only.
  FOREACH v_item IN ARRAY ARRAY[
    'warehouse_dispatch.create','warehouse_dispatch.edit_draft',
    'warehouse_dispatch.send','warehouse_dispatch.cancel'
  ] LOOP
    ASSERT NOT EXISTS (
      SELECT 1 FROM public.role_permission_defaults
      WHERE role = 'port_officer' AND permission_key = v_item AND allowed = true
    ), 'VERIFY FAILED (062): port_officer must never hold ' || v_item;
  END LOOP;

  FOREACH v_item IN ARRAY ARRAY[
    'warehouse_dispatch.view','warehouse_dispatch.accept','warehouse_dispatch.reject',
    'warehouse_dispatch.audit','reports.view','audit.view'
  ] LOOP
    ASSERT EXISTS (
      SELECT 1 FROM public.role_permission_defaults
      WHERE role = 'port_officer' AND permission_key = v_item AND allowed = true
    ), 'VERIFY FAILED (062): port_officer must hold ' || v_item;
  END LOOP;

  -- port_officer keeps the availability permissions its outlet workflow needs.
  ASSERT EXISTS (
    SELECT 1 FROM public.role_permission_defaults
    WHERE role = 'port_officer' AND permission_key = 'availability.update' AND allowed = true
  ), 'VERIFY FAILED (062): port_officer lost availability.update — 062 must not disturb the '
     'existing outlet workflow';

  SELECT count(*) INTO v_cnt FROM public.role_permission_defaults
  WHERE role = 'port_officer' AND permission_key LIKE 'users.%' AND allowed = true;
  ASSERT v_cnt = 0,
    'VERIFY FAILED (062): port_officer holds ' || v_cnt || ' users.* permission(s) by default';

  -- viewer: read-only, and provably so. No write/adjust/decision/admin key.
  FOREACH v_item IN ARRAY ARRAY[
    'warehouse_stock.adjust','warehouse_stock.correct','reports.financial','reports.export',
    'users.edit_scope','users.reset_permissions','warehouses.manage',
    'warehouse_dispatch.create','warehouse_dispatch.send','warehouse_dispatch.cancel',
    'warehouse_dispatch.accept','warehouse_dispatch.reject'
  ] LOOP
    ASSERT NOT EXISTS (
      SELECT 1 FROM public.role_permission_defaults
      WHERE role = 'viewer' AND permission_key = v_item AND allowed = true
    ), 'VERIFY FAILED (062): viewer must never hold the write/decision permission ' || v_item;
  END LOOP;

  FOREACH v_item IN ARRAY ARRAY[
    'warehouse_stock.view','warehouse_stock.movements_view','reports.view','audit.view'
  ] LOOP
    ASSERT EXISTS (
      SELECT 1 FROM public.role_permission_defaults
      WHERE role = 'viewer' AND permission_key = v_item AND allowed = true
    ), 'VERIFY FAILED (062): viewer must hold the read permission ' || v_item;
  END LOOP;

  -- institution_admin: oversight, not data entry, and never platform-wide.
  FOREACH v_item IN ARRAY ARRAY[
    'warehouse_stock.view','warehouse_stock.movements_view','reports.view','reports.financial',
    'reports.export','audit.view','users.edit_scope','users.reset_permissions'
  ] LOOP
    ASSERT EXISTS (
      SELECT 1 FROM public.role_permission_defaults
      WHERE role = 'institution_admin' AND permission_key = v_item AND allowed = true
    ), 'VERIFY FAILED (062): institution_admin must hold ' || v_item;
  END LOOP;

  FOREACH v_item IN ARRAY ARRAY['warehouse_stock.adjust','warehouse_stock.correct'] LOOP
    ASSERT NOT EXISTS (
      SELECT 1 FROM public.role_permission_defaults
      WHERE role = 'institution_admin' AND permission_key = v_item AND allowed = true
    ), 'VERIFY FAILED (062): institution_admin must not hold ' || v_item ||
       ' — oversight that can silently rewrite the quantities it oversees is not oversight';
  END LOOP;

  -- institution_admin gains no platform-wide bypass: organizations.create /
  -- .archive remain super_admin-only, exactly as 012 left them.
  FOREACH v_item IN ARRAY ARRAY['organizations.create','organizations.archive'] LOOP
    ASSERT NOT EXISTS (
      SELECT 1 FROM public.role_permission_defaults
      WHERE role = 'institution_admin' AND permission_key = v_item AND allowed = true
    ), 'VERIFY FAILED (062): institution_admin gained the platform-level permission ' || v_item;
  END LOOP;

  -- super_admin keeps the all-keys seeding convention: every key, including the
  -- ten new ones, is allowed.
  SELECT count(*) INTO v_cnt
  FROM public.permission_keys k
  WHERE NOT EXISTS (
    SELECT 1 FROM public.role_permission_defaults d
    WHERE d.role = 'super_admin' AND d.permission_key = k.key AND d.allowed = true
  );
  ASSERT v_cnt = 0,
    'VERIFY FAILED (062): super_admin is missing an allowed default for ' || v_cnt || ' permission key(s)';

  -- ===========================================================================
  -- 7. Legacy roles retained — the role CHECK is unchanged
  -- ===========================================================================
  SELECT pg_get_constraintdef(oid) INTO v_txt FROM pg_constraint WHERE conname = 'profiles_role_check';
  ASSERT v_txt IS NOT NULL, 'VERIFY FAILED (062): profiles_role_check missing';
  FOREACH v_item IN ARRAY ARRAY[
    'super_admin','institution_admin','warehouse_officer','port_officer',
    'monthly_status_officer','viewer',
    'hospital_admin','warehouse_manager','point_operator','transfer_manager'
  ] LOOP
    ASSERT v_txt LIKE '%''' || v_item || '''%',
      'VERIFY FAILED (062): profiles_role_check no longer accepts the role: ' || v_item ||
      ' — 062 must not remove or rename any legacy role';
  END LOOP;

  RAISE NOTICE 'Migration 062 VERIFY: part 1/2 passed (prerequisites, assignment schema, keys, role defaults, legacy roles).';
END $$;

DO $$
DECLARE
  v_cnt      int;
  v_txt      text;
  v_src      text;
  v_item     text;
  v_qual     text;
  v_expected text;
BEGIN
  -- ===========================================================================
  -- 8. phoenix_profile_has_permission — UNCHANGED from migration 017
  -- ===========================================================================
  -- Normalized-source equivalence, not a substring probe: every whitespace run is
  -- collapsed to one space and the result is compared to 017's body in full. Any
  -- edit — a reordered COALESCE arm, an added scope clause, a dropped
  -- `allowed is not null` — changes this string and rolls the migration back.
  SELECT btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_profile_has_permission';

  ASSERT v_src IS NOT NULL,
    'VERIFY FAILED (062): phoenix_profile_has_permission is missing — 062 must never touch it';

  v_expected :=
    'select coalesce( (select o.allowed from profile_permission_overrides o where o.profile_id = '
    'p_profile_id and o.permission_key = p_key and o.allowed is not null), (select d.allowed from '
    'role_permission_defaults d join profiles pr on pr.id = p_profile_id where d.role = pr.role and '
    'd.permission_key = p_key), false );';

  ASSERT v_src = v_expected,
    'VERIFY FAILED (062): phoenix_profile_has_permission''s source is no longer normalized-identical '
    'to migration 017''s definition. 062 must not modify the global permission helper — it adds '
    'phoenix_profile_has_scoped_permission instead. Found: ' || v_src;

  -- Its signature, volatility, security and search_path are equally part of the
  -- contract: a STABLE→VOLATILE or DEFINER→INVOKER change would alter behavior
  -- without touching the body at all.
  SELECT pg_get_function_identity_arguments(p.oid) INTO v_txt
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_profile_has_permission';
  ASSERT v_txt = 'p_profile_id uuid, p_key text',
    'VERIFY FAILED (062): phoenix_profile_has_permission signature changed — found: ' || COALESCE(v_txt, '<null>');

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_profile_has_permission'
      AND p.provolatile = 's'          -- STABLE
      AND p.prosecdef                  -- SECURITY DEFINER
      AND p.prorettype = 'boolean'::regtype
      AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql')
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ), 'VERIFY FAILED (062): phoenix_profile_has_permission lost its 017 volatility/security/language/search_path contract';

  -- Exactly one overload — 062 must not have added a scope-taking sibling under
  -- the same name, which would silently re-resolve existing call sites.
  SELECT count(*) INTO v_cnt FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_profile_has_permission';
  ASSERT v_cnt = 1,
    'VERIFY FAILED (062): phoenix_profile_has_permission must have exactly one overload, found ' || v_cnt;

  -- ===========================================================================
  -- 9. phoenix_profile_has_scoped_permission — exists, correct contract
  -- ===========================================================================
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_profile_has_scoped_permission'
  ), 'VERIFY FAILED (062): phoenix_profile_has_scoped_permission missing';

  SELECT pg_get_function_identity_arguments(p.oid) INTO v_txt
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_profile_has_scoped_permission';
  ASSERT v_txt = 'p_profile_id uuid, p_permission_key text, p_organization_id uuid, '
                 'p_warehouse_id uuid, p_distribution_point_id uuid',
    'VERIFY FAILED (062): scoped helper signature wrong — found: ' || COALESCE(v_txt, '<null>');

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_profile_has_scoped_permission'
      AND p.provolatile = 's'
      AND p.prosecdef
      AND p.prorettype = 'boolean'::regtype
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ), 'VERIFY FAILED (062): scoped helper must be STABLE, SECURITY DEFINER, boolean, with a pinned search_path';

  -- It must DELEGATE to the old helper, never reimplement the key evaluation.
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_profile_has_scoped_permission';
  ASSERT v_src LIKE '%phoenix_profile_has_permission(p_profile_id, p_permission_key)%',
    'VERIFY FAILED (062): scoped helper must call phoenix_profile_has_permission rather than '
    'reimplementing the permission evaluation — two implementations will drift';

  ASSERT v_src LIKE '%v_status IS DISTINCT FROM ''active''%',
    'VERIFY FAILED (062): scoped helper lost its active-profile requirement';
  ASSERT v_src LIKE '%p_warehouse_id IS NOT NULL AND p_distribution_point_id IS NOT NULL%',
    'VERIFY FAILED (062): scoped helper lost its both-targets fail-closed rule';
  ASSERT v_src LIKE '%phoenix_profile_has_warehouse_assignment%'
     AND v_src LIKE '%phoenix_profile_has_point_assignment%',
    'VERIFY FAILED (062): scoped helper lost its assignment requirement';
  ASSERT v_src NOT ILIKE '%EXCEPTION WHEN OTHERS%',
    'VERIFY FAILED (062): scoped helper contains a swallowing exception handler';

  -- --- Behavioral proof: it actually fails closed. -------------------------
  -- These call the live function; they need no fixture data, and they would fail
  -- for real if the guards above were cosmetic.
  ASSERT phoenix_profile_has_scoped_permission(NULL, 'warehouse_stock.view') = false,
    'VERIFY FAILED (062): scoped helper must return false for a NULL profile';

  ASSERT phoenix_profile_has_scoped_permission(
           '00000000-0000-0000-0000-0000000ffff1'::uuid, 'warehouse_stock.view') = false,
    'VERIFY FAILED (062): scoped helper must return false for a non-existent profile';

  ASSERT phoenix_profile_has_scoped_permission(
           '00000000-0000-0000-0000-0000000ffff1'::uuid, NULL) = false,
    'VERIFY FAILED (062): scoped helper must return false for a NULL permission key';

  ASSERT phoenix_profile_has_scoped_permission(
           '00000000-0000-0000-0000-0000000ffff1'::uuid, '') = false,
    'VERIFY FAILED (062): scoped helper must return false for an empty permission key';

  -- Every real profile, whatever its role, must be denied a permission key that
  -- does not exist — proving the delegation to the 017 helper is wired up and
  -- that no branch short-circuits to true before the key is evaluated. (super_admin
  -- is exempt by design: it is the platform role and returns true before the key
  -- check, exactly as the global helper's all-keys defaults already do.)
  SELECT count(*) INTO v_cnt
  FROM public.profiles p
  WHERE p.role <> 'super_admin'
    AND phoenix_profile_has_scoped_permission(
          p.id, 'phoenix.nonexistent.key.062.verify', p.organization_id) = true;
  ASSERT v_cnt = 0,
    'VERIFY FAILED (062): ' || v_cnt || ' non-super_admin profile(s) were granted a permission key '
    'that does not exist — the scoped helper is not delegating to phoenix_profile_has_permission';

  -- Organization isolation, proved against real rows: no non-super_admin profile
  -- may hold ANY scoped permission in an organization that is not its own.
  SELECT count(*) INTO v_cnt
  FROM public.profiles p
  CROSS JOIN public.organizations o
  WHERE p.role <> 'super_admin'
    AND o.id IS DISTINCT FROM p.organization_id
    AND phoenix_profile_has_scoped_permission(p.id, 'warehouse_stock.view', o.id) = true;
  ASSERT v_cnt = 0,
    'VERIFY FAILED (062): ' || v_cnt || ' profile/organization pair(s) cross the organization '
    'boundary through the scoped helper';

  -- Operational roles fail closed when their required resource scope is absent.
  SELECT count(*) INTO v_cnt
  FROM public.profiles p
  WHERE p.role IN ('warehouse_officer','port_officer')
    AND phoenix_profile_has_scoped_permission(p.id, 'warehouse_stock.view', p.organization_id) = true;
  ASSERT v_cnt = 0,
    'VERIFY FAILED (062): ' || v_cnt || ' operational-role profile(s) were authorized with no '
    'resource scope named — omitting the resource must never be more permissive than naming it';

  -- No non-super_admin override can escape its organization (the G3 rule, now
  -- enforced by trigger, re-proved through the helper's own answer).
  SELECT count(*) INTO v_cnt
  FROM public.profile_permission_overrides ovr
  JOIN public.profiles p ON p.id = ovr.profile_id
  WHERE p.role <> 'super_admin'
    AND ovr.scope_organization_id IS NOT NULL
    AND ovr.scope_organization_id IS DISTINCT FROM p.organization_id;
  ASSERT v_cnt = 0,
    'VERIFY FAILED (062): ' || v_cnt || ' non-super_admin override(s) cross profiles.organization_id';

  -- --- The assignment predicates ------------------------------------------
  FOREACH v_item IN ARRAY ARRAY[
    'phoenix_profile_has_warehouse_assignment','phoenix_profile_has_point_assignment'
  ] LOOP
    ASSERT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = v_item
        AND p.provolatile = 's' AND p.prosecdef
        AND p.prorettype = 'boolean'::regtype
        AND p.proconfig @> ARRAY['search_path=public, pg_temp']
    ), 'VERIFY FAILED (062): ' || v_item || ' missing or lacks the STABLE/DEFINER/search_path contract';

    SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_item;
    ASSERT v_src LIKE '%a.is_active%',
      'VERIFY FAILED (062): ' || v_item || ' does not require an ACTIVE assignment';
    ASSERT v_src LIKE '%p.status = ''active''%',
      'VERIFY FAILED (062): ' || v_item || ' does not require an active profile';
    ASSERT v_src LIKE '%a.organization_id = p.organization_id%',
      'VERIFY FAILED (062): ' || v_item || ' does not verify organization ownership';
  END LOOP;

  ASSERT phoenix_profile_has_warehouse_assignment(NULL, NULL) = false,
    'VERIFY FAILED (062): phoenix_profile_has_warehouse_assignment must fail closed on NULL';
  ASSERT phoenix_profile_has_point_assignment(NULL, NULL) = false,
    'VERIFY FAILED (062): phoenix_profile_has_point_assignment must fail closed on NULL';

  -- anon must not be able to execute any of the three new functions.
  FOREACH v_item IN ARRAY ARRAY[
    'phoenix_profile_has_scoped_permission',
    'phoenix_profile_has_warehouse_assignment',
    'phoenix_profile_has_point_assignment'
  ] LOOP
    ASSERT NOT EXISTS (
      SELECT 1 FROM information_schema.routine_privileges
      WHERE routine_schema = 'public' AND routine_name = v_item AND grantee = 'anon'
    ), 'VERIFY FAILED (062): anon holds EXECUTE on ' || v_item;
  END LOOP;

  -- ===========================================================================
  -- 10. Policies — replaced, scoped, and fail-closed
  -- ===========================================================================
  -- The superseded policies must be gone...
  FOREACH v_item IN ARRAY ARRAY[
    'wh_select_perm','warehouse_stock_select_perm','warehouse_stock_mov_select_perm',
    'warehouse_dispatches_select_perm','warehouse_dispatch_lines_select_perm'
  ] LOOP
    ASSERT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = v_item),
      'VERIFY FAILED (062): superseded policy still present: ' || v_item;
  END LOOP;

  -- ...and their scoped replacements present.
  FOREACH v_item IN ARRAY ARRAY[
    'wh_select_scoped','warehouse_stock_select_scoped','warehouse_stock_mov_select_scoped',
    'warehouse_dispatches_select_scoped','warehouse_dispatch_lines_select_scoped',
    'psa_select_scoped'
  ] LOOP
    ASSERT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = v_item),
      'VERIFY FAILED (062): replacement policy missing: ' || v_item;
  END LOOP;

  -- Warehouse master: assignment-scoped, and 060's write policies untouched.
  SELECT qual INTO v_qual FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'warehouses' AND policyname = 'wh_select_scoped';
  ASSERT v_qual LIKE '%phoenix_profile_has_warehouse_assignment%',
    'VERIFY FAILED (062): wh_select_scoped is not assignment-scoped';
  ASSERT v_qual LIKE '%warehouses.view%',
    'VERIFY FAILED (062): wh_select_scoped lost the warehouses.view key test';
  ASSERT v_qual LIKE '%phoenix_my_org()%',
    'VERIFY FAILED (062): wh_select_scoped lost its organization test';

  FOREACH v_item IN ARRAY ARRAY['wh_insert_perm','wh_update_perm'] LOOP
    ASSERT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'warehouses' AND policyname = v_item),
      'VERIFY FAILED (062): 060 write policy ' || v_item || ' was removed — 062 replaces SELECT only';
  END LOOP;

  -- Stock + movements: scoped, and gated on their OWN new keys.
  SELECT qual INTO v_qual FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'warehouse_stock'
    AND policyname = 'warehouse_stock_select_scoped';
  ASSERT v_qual LIKE '%warehouse_stock.view%',
    'VERIFY FAILED (062): warehouse_stock_select_scoped must gate on warehouse_stock.view';
  ASSERT v_qual LIKE '%phoenix_profile_has_warehouse_assignment%',
    'VERIFY FAILED (062): warehouse_stock_select_scoped is not assignment-scoped';

  SELECT qual INTO v_qual FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'warehouse_stock_movements'
    AND policyname = 'warehouse_stock_mov_select_scoped';
  ASSERT v_qual LIKE '%warehouse_stock.movements_view%',
    'VERIFY FAILED (062): warehouse_stock_mov_select_scoped must gate on warehouse_stock.movements_view';
  ASSERT v_qual LIKE '%phoenix_profile_has_warehouse_assignment%',
    'VERIFY FAILED (062): warehouse_stock_mov_select_scoped is not assignment-scoped';

  -- Dispatch header: BOTH sides scoped by their own assignment kind.
  SELECT qual INTO v_qual FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'warehouse_dispatches'
    AND policyname = 'warehouse_dispatches_select_scoped';
  ASSERT v_qual LIKE '%phoenix_profile_has_warehouse_assignment%',
    'VERIFY FAILED (062): dispatch header policy does not scope warehouse_officer by warehouse assignment';
  ASSERT v_qual LIKE '%phoenix_profile_has_point_assignment%',
    'VERIFY FAILED (062): dispatch header policy does not scope port_officer by outlet assignment';
  ASSERT v_qual LIKE '%warehouse_dispatch.view%',
    'VERIFY FAILED (062): dispatch header policy lost the warehouse_dispatch.view key test';

  -- Dispatch lines: visibility DERIVED through the header, never from the line's
  -- own organization_id.
  SELECT qual INTO v_qual FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'warehouse_dispatch_lines'
    AND policyname = 'warehouse_dispatch_lines_select_scoped';
  ASSERT v_qual LIKE '%warehouse_dispatches%',
    'VERIFY FAILED (062): dispatch line policy does not reference the header table';
  ASSERT v_qual LIKE '%dispatch_id%',
    'VERIFY FAILED (062): dispatch line policy does not join on dispatch_id';
  ASSERT v_qual LIKE '%EXISTS%',
    'VERIFY FAILED (062): dispatch line policy must derive visibility via EXISTS on the header';
  ASSERT v_qual LIKE '%phoenix_profile_has_warehouse_assignment%'
     AND v_qual LIKE '%phoenix_profile_has_point_assignment%',
    'VERIFY FAILED (062): dispatch line policy lost the header''s assignment scoping';
  -- The line's own organization_id must NOT be the basis of visibility. The
  -- header's is (`d.organization_id`), which is a different thing entirely.
  ASSERT v_qual NOT LIKE '%(organization_id = phoenix_my_org())%',
    'VERIFY FAILED (062): dispatch line policy trusts warehouse_dispatch_lines.organization_id '
    'directly — visibility must derive through the dispatch header';

  -- Assignment table RLS.
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.profile_scope_assignments'::regclass),
    'VERIFY FAILED (062): RLS not enabled on profile_scope_assignments';

  SELECT qual INTO v_qual FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'profile_scope_assignments'
    AND policyname = 'psa_select_scoped';
  ASSERT v_qual LIKE '%super_admin%',
    'VERIFY FAILED (062): psa_select_scoped lost the super_admin branch';
  ASSERT v_qual LIKE '%users.view%',
    'VERIFY FAILED (062): psa_select_scoped lost the users.view org-management branch';
  ASSERT v_qual LIKE '%auth.uid()%',
    'VERIFY FAILED (062): psa_select_scoped lost the own-assignments branch';

  -- No direct authenticated writes anywhere in the scoped domain, and no anon
  -- privilege of any kind.
  FOREACH v_item IN ARRAY ARRAY[
    'profile_scope_assignments','warehouse_stock','warehouse_stock_movements',
    'warehouse_dispatches','warehouse_dispatch_lines'
  ] LOOP
    ASSERT NOT EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = v_item AND grantee = 'anon'
    ), 'VERIFY FAILED (062): anon holds a privilege on ' || v_item;

    ASSERT NOT EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = v_item
        AND grantee = 'authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE')
    ), 'VERIFY FAILED (062): authenticated holds a direct write grant on ' || v_item;

    ASSERT NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_item
        AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
    ), 'VERIFY FAILED (062): a direct write policy exists on ' || v_item;
  END LOOP;

  -- No policy anywhere in this domain may address the anon role.
  SELECT count(*) INTO v_cnt FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('profile_scope_assignments','warehouses','warehouse_stock',
                      'warehouse_stock_movements','warehouse_dispatches','warehouse_dispatch_lines')
    AND 'anon' = ANY (roles);
  ASSERT v_cnt = 0,
    'VERIFY FAILED (062): ' || v_cnt || ' policy/policies grant the anon role access';

  -- ===========================================================================
  -- 11. Last super-admin protection
  -- ===========================================================================
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.profiles'::regclass
      AND t.tgname = 'trg_protect_last_super_admin'
      AND NOT t.tgisinternal
  ), 'VERIFY FAILED (062): trg_protect_last_super_admin missing';

  -- BEFORE (tgtype bit 1) and fires on UPDATE (bit 16) and DELETE (bit 8), per row (bit 0).
  SELECT t.tgtype::int INTO v_cnt FROM pg_trigger t
  WHERE t.tgrelid = 'public.profiles'::regclass AND t.tgname = 'trg_protect_last_super_admin';
  ASSERT (v_cnt & 1) = 1,
    'VERIFY FAILED (062): trg_protect_last_super_admin must be BEFORE — an AFTER trigger observes '
    'the loss instead of preventing it';
  ASSERT (v_cnt & 16) = 16,
    'VERIFY FAILED (062): trg_protect_last_super_admin must fire on UPDATE (demotion/disabling)';
  ASSERT (v_cnt & 8) = 8,
    'VERIFY FAILED (062): trg_protect_last_super_admin must fire on DELETE';

  -- Whitespace-normalized, so these assertions test the LOGIC and cannot be
  -- broken (or satisfied) by reformatting the function body.
  SELECT btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_protect_last_super_admin';
  ASSERT v_src IS NOT NULL, 'VERIFY FAILED (062): phoenix_protect_last_super_admin missing';

  -- The stable machine-readable token 063 will map.
  ASSERT v_src LIKE '%LAST_SUPER_ADMIN_PROTECTED%',
    'VERIFY FAILED (062): the stable error token LAST_SUPER_ADMIN_PROTECTED is missing';

  -- The advisory lock. Without it the trigger loses every concurrent race.
  ASSERT v_src LIKE '%pg_advisory_xact_lock(778062062)%',
    'VERIFY FAILED (062): the trigger must take pg_advisory_xact_lock(778062062) before counting — '
    'without it two concurrent administrators each see "one other remains" and both succeed, '
    'leaving zero active super_admins';

  -- Transaction-scoped only: a session-level lock would have to be released by
  -- hand and would leak on error.
  ASSERT v_src NOT LIKE '%pg_advisory_lock(%',
    'VERIFY FAILED (062): the trigger must use a transaction-scoped advisory lock, not a session one';

  -- Every protected transition is covered.
  ASSERT v_src LIKE '%NEW.role IS DISTINCT FROM ''super_admin''%',
    'VERIFY FAILED (062): the trigger does not cover DEMOTION (role change away from super_admin)';
  ASSERT v_src LIKE '%NEW.status IS DISTINCT FROM ''active''%',
    'VERIFY FAILED (062): the trigger does not cover DISABLING (status change away from active)';
  ASSERT v_src LIKE '%TG_OP = ''DELETE''%',
    'VERIFY FAILED (062): the trigger does not cover DELETION';
  ASSERT v_src LIKE '%OLD.organization_id IS NULL%' AND v_src LIKE '%NEW.organization_id IS NOT NULL%',
    'VERIFY FAILED (062): the trigger does not cover ORGANIZATION SCOPING of the last global admin';
  ASSERT v_src NOT ILIKE '%EXCEPTION WHEN OTHERS%',
    'VERIFY FAILED (062): the trigger contains a swallowing exception handler';

  -- The trigger must be ENABLED for every write path, including service_role.
  -- tgenabled 'O' = origin (fires for normal writes); 'D' = disabled.
  SELECT t.tgenabled INTO v_txt FROM pg_trigger t
  WHERE t.tgrelid = 'public.profiles'::regclass AND t.tgname = 'trg_protect_last_super_admin';
  ASSERT v_txt IN ('O','A'),
    'VERIFY FAILED (062): trg_protect_last_super_admin is not enabled (tgenabled = ' || v_txt || ')';

  -- Exactly one active super_admin is a VALID state, and at least one must exist
  -- for this migration to be meaningful (the protection has to protect someone).
  SELECT count(*) INTO v_cnt FROM public.profiles
  WHERE role = 'super_admin' AND status = 'active';
  ASSERT v_cnt >= 1,
    'VERIFY FAILED (062): no active super_admin exists — migration 062 requires at least one '
    '(exactly one is valid and is what the trigger protects). Create one before applying.';

  -- ===========================================================================
  -- 12. profile_permission_overrides — PK and three-state preserved
  -- ===========================================================================
  SELECT pg_get_constraintdef(c.oid) INTO v_txt
  FROM pg_constraint c
  WHERE c.conrelid = 'public.profile_permission_overrides'::regclass AND c.contype = 'p';
  ASSERT v_txt = 'PRIMARY KEY (profile_id, permission_key)',
    'VERIFY FAILED (062): profile_permission_overrides PRIMARY KEY changed — found: ' || COALESCE(v_txt, '<null>');

  -- Three-state: `allowed` must stay NULLable, or "inherit" becomes unexpressible.
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profile_permission_overrides'
      AND column_name = 'allowed' AND is_nullable = 'YES'
  ), 'VERIFY FAILED (062): profile_permission_overrides.allowed must stay nullable — NULL is the '
     '"inherit the role default" state of the three-state model';

  -- The scope columns 010 created are still there and still nullable.
  FOREACH v_item IN ARRAY ARRAY['scope_organization_id','scope_warehouse_id','scope_point_id'] LOOP
    ASSERT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profile_permission_overrides'
        AND column_name = v_item AND is_nullable = 'YES'
    ), 'VERIFY FAILED (062): profile_permission_overrides.' || v_item || ' missing or not nullable';
  END LOOP;

  FOREACH v_item IN ARRAY ARRAY[
    'ppo_single_resource_scope_chk','ppo_scope_warehouse_org_fk','ppo_scope_point_org_fk'
  ] LOOP
    ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_item),
      'VERIFY FAILED (062): override safety constraint missing: ' || v_item;
  END LOOP;

  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.profile_permission_overrides'::regclass
      AND t.tgname = 'trg_validate_ppo_scope' AND NOT t.tgisinternal
  ), 'VERIFY FAILED (062): trg_validate_ppo_scope missing';

  -- 017's RPCs must still exist and be untouched by this migration.
  FOREACH v_item IN ARRAY ARRAY[
    'assign_profile_permissions','reset_profile_permissions','get_effective_permissions',
    'assign_profile_role','phoenix_my_role','phoenix_my_org'
  ] LOOP
    ASSERT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = v_item
    ), 'VERIFY FAILED (062): pre-existing function missing: ' || v_item || ' — 062 must not touch it';
  END LOOP;

  -- ===========================================================================
  -- 13. Isolation — untouched domains
  -- ===========================================================================
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_public_qr_payload';
  ASSERT v_src IS NOT NULL,
    'VERIFY FAILED (062): get_public_qr_payload is missing — 062 must not touch public QR';
  ASSERT v_src NOT ILIKE '%profile_scope_assignments%'
     AND v_src NOT ILIKE '%warehouse_stock%'
     AND v_src NOT ILIKE '%internal_batch_reference%',
    'VERIFY FAILED (062): the public QR payload leaked a scope/warehouse/internal field';

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_clean_availability_data'
  ), 'VERIFY FAILED (062): phoenix_clean_availability_data missing — 062 must not touch Deep Clean (055)';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'inter_org_exchange_requests'
  ), 'VERIFY FAILED (062): inter_org_exchange_requests missing — 062 must not touch the exchange domain';
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inter_org_exchange_requests_orgs_distinct_chk'
  ), 'VERIFY FAILED (062): exchange orgs-distinct constraint missing — the exchange domain must be untouched';

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_upsert_availability'
  ), 'VERIFY FAILED (062): phoenix_upsert_availability missing — 062 must not touch the outlet editor';

  -- 062 creates no user-administration or dispatch RPC — those are 063's.
  FOREACH v_item IN ARRAY ARRAY[
    'phoenix_assign_profile_scope','phoenix_revoke_profile_scope',
    'phoenix_create_dispatch','phoenix_send_dispatch','phoenix_accept_dispatch_line',
    'phoenix_reject_dispatch_line','phoenix_cancel_dispatch'
  ] LOOP
    ASSERT NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = v_item
    ), 'VERIFY FAILED (062): ' || v_item || ' exists — 062 must create no user-administration or '
       'dispatch RPC (migration 063 owns those)';
  END LOOP;

  -- 062 writes no assignment row: assignments are an administrative act, not a
  -- schema migration's guess about who works where.
  SELECT count(*) INTO v_cnt FROM public.profile_scope_assignments;
  ASSERT v_cnt = 0,
    'VERIFY FAILED (062): ' || v_cnt || ' profile_scope_assignments row(s) exist — 062 must create none';

  RAISE NOTICE 'Migration 062 VERIFY: part 2/2 passed. profile_scope_assignments created with structural org pinning (composite FKs to warehouses/distribution_points), a fail-closed profile-org + live-target validation trigger, partial active-assignment uniqueness that still permits multiple distinct targets and preserves revoked history; ten new permission keys added; warehouse_officer stripped of warehouses.manage and given precise stock keys; port_officer denied all warehouse stock; separation of duty preserved on both sides; viewer read-only; every legacy role retained; phoenix_profile_has_permission proved normalized-identical to migration 017 and untouched; phoenix_profile_has_scoped_permission added (STABLE/SECURITY DEFINER/pinned search_path, delegating to the old helper, failing closed on inactive profile, cross-org, both-targets, missing assignment and absent resource scope); warehouse/stock/movement/dispatch SELECT policies replaced with assignment-scoped versions; dispatch lines derive visibility through the header; no direct authenticated write and no anon privilege anywhere; the last active super_admin protected against deletion, disabling, demotion and org-scoping under an advisory lock with the stable token LAST_SUPER_ADMIN_PROTECTED; profile_permission_overrides PK and three-state model unchanged; public QR, Deep Clean, the exchange domain and the outlet editor untouched; no RPC and no assignment row created (063 scope).';
END $$;

commit;

-- =============================================================================
-- END OF MIGRATION 062
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PRE-APPLY READINESS CHECKS (run BEFORE applying 061, one block at a time)
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. At least one active super_admin must exist — 062's VERIFY requires it, and
--    the trigger it installs needs someone to protect:
--      select id, full_name, status, organization_id from profiles
--      where role = 'super_admin' and status = 'active';
--    -- expect >= 1 row. Exactly one is valid; a second is recommended for
--    -- operational resilience but is NOT required by this migration.
--
-- 2. Migration 060 must be applied and healthy:
--      select count(*) from information_schema.tables
--      where table_schema = 'public'
--        and table_name in ('warehouse_stock','warehouse_stock_movements');
--    -- expect 2
--
-- 3. Migration 061 must NOT be applied yet (it is applied in step 2 of the order
--    below):
--      select count(*) from information_schema.tables
--      where table_schema = 'public'
--        and table_name in ('warehouse_dispatches','warehouse_dispatch_lines');
--    -- expect 0 before applying 061; expect 2 after.
--
-- 4. The override scope columns must be clean (062's G1–G3 prechecks re-prove
--    this transactionally, but knowing in advance avoids a rolled-back window):
--      select count(*) from profile_permission_overrides
--      where num_nonnulls(scope_warehouse_id, scope_point_id) > 1
--         or scope_organization_id is not null;
--    -- expect 0 (no code path has ever written these columns).
--
-- 5. The global permission helper must still match migration 017 — 062's VERIFY
--    fails the whole transaction if it has drifted:
--      select pg_get_functiondef('public.phoenix_profile_has_permission(uuid,text)'::regprocedure);
--    -- expect exactly migration 017 section A's body.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- APPLY ORDER
-- ─────────────────────────────────────────────────────────────────────────────
--   1. Run the readiness checks above.
--   2. Apply 061_phoenix_warehouse_dispatch_schema.sql.
--   3. IMMEDIATELY apply this file (062).
--   4. Run the post-apply verification below.
--   5. Keep dispatch functionality unexposed in the UI until both succeed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POST-APPLY VERIFICATION (run manually, one block at a time)
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The assignment table and its guards:
--      select conname, pg_get_constraintdef(oid) from pg_constraint
--      where conrelid = 'public.profile_scope_assignments'::regclass order by conname;
--      select indexname, indexdef from pg_indexes
--      where schemaname = 'public' and tablename = 'profile_scope_assignments';
--    -- expect psa_warehouse_org_fk / psa_point_org_fk to be COMPOSITE on
--    -- organization_id, and both active-uniqueness indexes to be PARTIAL.
--
-- 2. warehouse_officer no longer manages warehouses:
--      select permission_key, allowed from role_permission_defaults
--      where role = 'warehouse_officer'
--        and permission_key in ('warehouses.view','warehouses.manage',
--                               'warehouse_stock.view','warehouse_stock.adjust',
--                               'warehouse_dispatch.accept','warehouse_dispatch.reject')
--      order by permission_key;
--    -- expect: warehouses.manage = false, warehouses.view = true,
--    --         warehouse_stock.* = true, dispatch accept/reject = false.
--
-- 3. The old helper is byte-identical to 017:
--      select pg_get_functiondef('public.phoenix_profile_has_permission(uuid,text)'::regprocedure);
--
-- 4. The new helper fails closed:
--      select phoenix_profile_has_scoped_permission(null, 'warehouse_stock.view');  -- false
--      select phoenix_profile_has_scoped_permission(gen_random_uuid(), 'warehouse_stock.view'); -- false
--
-- 5. The scoped policies are live:
--      select tablename, policyname, cmd from pg_policies
--      where schemaname = 'public'
--        and tablename in ('warehouses','warehouse_stock','warehouse_stock_movements',
--                          'warehouse_dispatches','warehouse_dispatch_lines',
--                          'profile_scope_assignments')
--      order by tablename, policyname;
--    -- expect only *_scoped SELECT policies (+ 060's wh_insert_perm/wh_update_perm),
--    -- and NO policy naming the anon role.
--
-- 6. The last-super-admin trigger is installed and enabled:
--      select tgname, tgenabled from pg_trigger
--      where tgrelid = 'public.profiles'::regclass and not tgisinternal;
--    -- expect trg_protect_last_super_admin with tgenabled = 'O'.
--
-- 7. Prove the protection bites, WITHOUT committing anything:
--      begin;
--        update profiles set status = 'suspended'
--        where id = (select id from profiles where role = 'super_admin' and status = 'active' limit 1);
--      rollback;
--    -- expect ERROR: LAST_SUPER_ADMIN_PROTECTED ... (only when exactly one
--    -- active super_admin exists; with two, this succeeds — roll back either way).
--
-- 8. No data was created or destroyed by this migration:
--      select count(*) from profile_scope_assignments;        -- expect 0
--      select count(*) from profile_permission_overrides;     -- unchanged
--      select count(*) from warehouse_dispatches;             -- expect 0
--    -- This file contains no DELETE, no TRUNCATE, and no DROP of any table,
--    -- column or function — only DROP POLICY for the five policies it replaces.
-- =============================================================================

