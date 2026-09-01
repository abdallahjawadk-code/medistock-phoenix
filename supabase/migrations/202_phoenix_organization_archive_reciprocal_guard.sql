-- ============================================================================
-- MEDISTOCK PHOENIX v2.1 — ORGANIZATION ARCHIVE RECIPROCAL GUARD — 202
--
-- Closes the KNOWN RESIDUAL migration 201 disclosed rather than papered over:
-- M201 makes the ARCHIVE decision race-free (FOR UPDATE fence, true count at
-- decision time), but a dependency write that lands in a LATER transaction can
-- still create, move, or reactivate a live warehouse / distribution_point /
-- qr_token / item_availability row underneath an already-archived organization.
-- For qr_tokens the write touches no foreign key and takes no parent lock at
-- all, so no amount of locking discipline on the archive side alone can close
-- it (proven on a disposable rig, two-session concurrent reproduction).
--
-- WHY status ALONE CANNOT BE THE RECIPROCAL SIGNAL
--   public.organizations has no column that distinguishes "archived" from
--   "built but not yet activated" — both read status='inactive'. Migration
--   181 depends on the second meaning: a health-sector organization is
--   created inactive and its ACTIVE warehouses, depots and facilities are
--   inserted underneath it before the activation guard validates the
--   finished topology. A prior attempt at this exact fix (commit 75545de8,
--   reverted at fabf829b in this same migration's history) keyed the
--   reciprocal rule off status='inactive' directly and broke that flow —
--   181-closure-round1.dynamic.test.ts failed against it. This migration
--   avoids that mistake by introducing an explicit, additive marker instead
--   of overloading status.
--
-- WHAT THIS MIGRATION DOES
--   1. Adds organizations.archived_at timestamptz (nullable, no default).
--      Every existing row becomes archived_at IS NULL — the only
--      deterministic backfill for a schema with no prior audit trail of
--      archive events (owner-verified Production census: 0 organization
--      rows exist today, so there is no legacy population to classify).
--   2. Extends the M201 guard function (CREATE OR REPLACE — migration 201's
--      own file on disk is untouched) to stamp archived_at := now() on a
--      legal archive, and to clear it back to NULL on restoration
--      (status inactive -> active). The M201 dependency-check body is
--      preserved verbatim.
--   3. Independently closes a forgery hole the archived_at marker would
--      otherwise open: because 'archived_at' must join the trigger's column
--      list for (2) above to be observable, a bare
--      `UPDATE organizations SET archived_at = ...` (status untouched)
--      would now also fire the guard. The function unconditionally resets
--      NEW.archived_at := OLD.archived_at at entry; only the two authorized
--      branches (restore-clear, legal-archive-stamp) may override that
--      default before RETURN. A client can never set, clear, or backdate
--      archived_at directly — through authenticated, service_role, or any
--      SECURITY DEFINER writer — the value is silently normalized back to
--      the database's own record, not rejected, so an unrelated field in the
--      same generic-edit-form save (InstitutionScreen.tsx's status <select>
--      always resends `status`) can never be broken by this guard. The
--      trigger also fires on INSERT (OLD does not exist there, so the
--      entry-reset above does not apply): NEW.archived_at is unconditionally
--      forced to NULL for every INSERT, since a freshly created row cannot
--      already be archived and no dependency could reference it yet either
--      way. Without this, a plain `INSERT ... (status, archived_at) VALUES
--      ('active', <anything>)` — reachable by the same authenticated/
--      super_admin callers this migration's threat model already covers —
--      would silently stick, contradicting this guarantee (independent
--      review, ISW2 round 2).
--   4. Adds ONE new SECURITY DEFINER function and four BEFORE INSERT OR
--      UPDATE triggers — one per M201 canonical blocking class — that
--      refuse a write making a row LIVE under a parent whose archived_at is
--      NOT NULL. Liveness per class:
--        warehouses / distribution_points : status IS DISTINCT FROM 'archived'
--        qr_tokens                        : status = 'active'
--        item_availability                : every row (no status column)
--      A pre-activation organization has archived_at IS NULL throughout
--      construction, so M181's flow is untouched — this is the entire reason
--      the marker exists instead of reusing status.
--
-- WHY SECURITY DEFINER (both functions)
--   Identical justification to M201: each guard must read the parent's
--   authoritative state (dependency counts / archived_at) even when the
--   caller's own RLS view is narrower than reality. A SECURITY INVOKER guard
--   would silently fail OPEN for such a caller — the exact defect class this
--   migration and M201 both exist to close. search_path is pinned on both
--   functions to public, pg_temp; EXECUTE is revoked from PUBLIC on both;
--   reachable only through their triggers.
--
-- CONCURRENCY
--   The archive guard takes FOR UPDATE on the organization row (unchanged
--   from M201). The new child guard takes FOR KEY SHARE on the organization
--   row before checking archived_at. FOR KEY SHARE does not conflict with
--   FOR KEY SHARE, so concurrent sibling writes under the same live
--   organization do not serialize against each other. FOR UPDATE conflicts
--   with FOR KEY SHARE, so whichever of {archive, child write} reaches the
--   organization row's lock second waits for the first to finish, then sees
--   its committed effect: an archive-first ordering blocks the child write
--   until the archive commits, then refuses it (archived_at now NOT NULL); a
--   child-first ordering blocks the archive until the child commits, then
--   the existing M201 dependency count refuses the archive (count now > 0).
--   Neither guard takes a second lock, so this migration introduces no new
--   deadlock-ordering path beyond what M201 already carried (a genuine
--   deadlock is 40P01, retry-safe, not corruption).
--
-- SCOPE BOUNDARY — DISCLOSED, NOT SILENT
--   The four canonical classes above are exactly M201's own blocking set,
--   mirrored filter-for-filter from canArchive in
--   src/shared/supabase/services/lifecycle.service.ts, so the server and the
--   Product UI can never disagree about what counts as a live dependency.
--   local_items, organization_facilities and qr_targets are NOT covered —
--   widening that set is a Product-contract decision, not a race fix, and
--   must widen the M201 archive-refusal count and this guard together in a
--   separate change or the UI's own preview will disagree with the server.
--
-- BYPASS THAT REMAINS OPEN — pre-existing, not introduced here
--   A superuser session with session_replication_role='replica' disables
--   ordinary triggers and would bypass this guard and M201 alike. On this
--   stack only supabase_admin is superuser (postgres and service_role are
--   bypassrls but not superuser). Closing that requires an event trigger or
--   an out-of-database control and is explicitly out of scope.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION '202_precondition_failed: public.organizations is absent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'archived_at'
  ) THEN
    RAISE EXCEPTION '202_precondition_failed: organizations.archived_at already exists';
  END IF;
  IF to_regprocedure('public._phoenix_organization_archive_dependency_guard_v1()') IS NULL THEN
    RAISE EXCEPTION '202_precondition_failed: migration 201''s guard function is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'organizations_archive_dependency_guard_trg') THEN
    RAISE EXCEPTION '202_precondition_failed: migration 201''s trigger is absent';
  END IF;
  IF to_regclass('public.warehouses') IS NULL
     OR to_regclass('public.distribution_points') IS NULL
     OR to_regclass('public.qr_tokens') IS NULL
     OR to_regclass('public.item_availability') IS NULL THEN
    RAISE EXCEPTION '202_precondition_failed: a canonical dependency table is absent';
  END IF;
END;
$preflight$;

-- ----------------------------------------------------------------------------
-- 1. additive schema change — the entire backfill (every existing row gets
--    archived_at = NULL, i.e. "not archived"; owner-verified Production
--    census confirms zero existing organization rows, so no history is
--    invented or guessed for any legacy row).
-- ----------------------------------------------------------------------------
ALTER TABLE public.organizations ADD COLUMN archived_at timestamptz;

COMMENT ON COLUMN public.organizations.archived_at IS
  'Set only by _phoenix_organization_archive_dependency_guard_v1() (202) on a legal archive; cleared only by the same function on restoration (inactive -> active). NULL for every pre-activation draft and every never-archived organization. Never client-writable — direct UPDATEs are silently normalized back to the prior value.';

-- ----------------------------------------------------------------------------
-- 2 & 3. archive guard replace — M201 body preserved verbatim, plus the
--    entry-reset (closes direct archived_at forgery) and the two authorized
--    assignments (restore-clear, legal-archive-stamp).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_organization_archive_dependency_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_warehouses          bigint;
  v_distribution_points bigint;
  v_qr_tokens           bigint;
  v_item_availability   bigint;
BEGIN
  -- 202: archived_at is database-owned and stamped only by a legal archive
  -- transition further below, which can only ever happen via UPDATE. A
  -- freshly INSERTed organization cannot already be archived, so no client
  -- value is honored regardless of what the caller supplies (independent
  -- review, ISW2: an INSERT specifying archived_at directly is otherwise
  -- unguarded, since OLD does not exist for INSERT and the reset below only
  -- covers UPDATE). No dependency check is needed here either — nothing can
  -- reference an organization_id before the row insertING it commits.
  IF TG_OP = 'INSERT' THEN
    NEW.archived_at := NULL;
    RETURN NEW;
  END IF;

  -- 202: archived_at is database-owned. Reset to the existing value before
  -- evaluating anything else; only the two branches below may override it.
  NEW.archived_at := OLD.archived_at;

  -- 202: restoration. inactive -> active always clears the marker — a no-op
  -- for a pre-activation draft (already NULL), a real clear for a genuine
  -- archive/restore. This is a live, unconfirmed Product path today
  -- (InstitutionScreen.tsx's generic status editor), not a hypothetical.
  IF NEW.status = 'active' AND OLD.status IS NOT DISTINCT FROM 'inactive' THEN
    NEW.archived_at := NULL;
    RETURN NEW;
  END IF;

  -- Only a transition INTO 'inactive' is an archive. Re-archiving an already
  -- inactive organization, activation (handled above), suspension, and every
  -- unrelated column update — including an archived_at-only UPDATE, now
  -- reachable because the trigger's column list widens below — fall through
  -- with the reset value from the top of this function already in place.
  IF NEW.status IS DISTINCT FROM 'inactive' OR OLD.status IS NOT DISTINCT FROM 'inactive' THEN
    RETURN NEW;
  END IF;

  -- Serialization fence — see CONCURRENCY above. The row is already locked by
  -- the UPDATE, but only FOR NO KEY UPDATE; this upgrades it so a concurrent
  -- dependency INSERT/UPDATE (which takes FOR KEY SHARE via its own guard
  -- below) cannot slip past the count.
  PERFORM 1 FROM public.organizations WHERE id = NEW.id FOR UPDATE;

  SELECT count(*) INTO v_warehouses
    FROM public.warehouses
   WHERE organization_id = NEW.id AND status <> 'archived';

  SELECT count(*) INTO v_distribution_points
    FROM public.distribution_points
   WHERE organization_id = NEW.id AND status <> 'archived';

  SELECT count(*) INTO v_qr_tokens
    FROM public.qr_tokens
   WHERE organization_id = NEW.id AND status = 'active';

  SELECT count(*) INTO v_item_availability
    FROM public.item_availability
   WHERE organization_id = NEW.id;

  IF v_warehouses > 0
     OR v_distribution_points > 0
     OR v_qr_tokens > 0
     OR v_item_availability > 0 THEN
    RAISE EXCEPTION 'organization_archive_blocked_by_dependencies'
      USING ERRCODE = '23514',
      DETAIL = format(
        'warehouses=%s distribution_points=%s qr_tokens=%s item_availability=%s',
        v_warehouses, v_distribution_points, v_qr_tokens, v_item_availability
      ),
      HINT = 'Clear or archive the organization''s warehouses, outlets, active QR tokens and availability rows before archiving it.';
  END IF;

  -- 202: authorized assignment — the marker can only ever be stamped on a
  -- LEGAL archive, i.e. after every dependency count above is proven zero.
  NEW.archived_at := now();
  RETURN NEW;
END;
$function$;

-- Widen the column list so an UPDATE that touches only archived_at (never
-- status) still invokes the guard — without this, Finding G1's forgery hole
-- stays open regardless of the entry-reset logic above.
DROP TRIGGER IF EXISTS organizations_archive_dependency_guard_trg ON public.organizations;

CREATE TRIGGER organizations_archive_dependency_guard_trg
  BEFORE INSERT OR UPDATE OF status, archived_at ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_organization_archive_dependency_guard_v1();

-- ----------------------------------------------------------------------------
-- 4. reciprocal child-side guard — new function, four new triggers.
--    MANDATORY: liveness is dispatched with IF/ELSIF, never a CASE
--    expression. item_availability has no status column; a CASE branch tree
--    is planned as a whole and raises "record NEW has no field status" for
--    that table even when the status arm does not apply, because PL/pgSQL
--    only defers per-statement compilation for IF/ELSIF, not for a single
--    CASE expression spanning branches with incompatible row shapes.
-- ----------------------------------------------------------------------------
CREATE FUNCTION public._phoenix_assert_parent_not_archived_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_class       text := TG_ARGV[0];
  v_is_live     boolean;
  v_unchanged   boolean;
  v_archived_at timestamptz;
BEGIN
  IF v_class = 'not_archived' THEN
    v_is_live := (NEW.status IS DISTINCT FROM 'archived');
  ELSIF v_class = 'active_only' THEN
    v_is_live := (NEW.status = 'active');
  ELSE
    -- 'any' — item_availability, which has no status column: every row counts.
    v_is_live := true;
  END IF;

  IF NOT v_is_live THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Routine updates that touch neither organization_id nor (where the
    -- table has one) status never need to pay the guard's lock cost.
    IF v_class = 'not_archived' OR v_class = 'active_only' THEN
      v_unchanged := (NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id)
                 AND (NEW.status IS NOT DISTINCT FROM OLD.status);
    ELSE
      v_unchanged := (NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id);
    END IF;

    IF v_unchanged THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Authoritative read of the parent's archive marker — see WHY SECURITY
  -- DEFINER above. FOR KEY SHARE is the concurrency fence: see CONCURRENCY.
  SELECT archived_at INTO v_archived_at
    FROM public.organizations
   WHERE id = NEW.organization_id
   FOR KEY SHARE;

  IF v_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'dependency_write_blocked_by_archived_organization'
      USING ERRCODE = '23514',
      DETAIL = format(
        'table=%s organization=%s archived_at=%s operation=%s',
        TG_TABLE_NAME, NEW.organization_id, v_archived_at, TG_OP
      ),
      HINT = 'Restore the organization before creating, moving, or reactivating a dependency under it.';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._phoenix_assert_parent_not_archived_v1() FROM PUBLIC;

DROP TRIGGER IF EXISTS warehouses_parent_not_archived_trg ON public.warehouses;
CREATE TRIGGER warehouses_parent_not_archived_trg
  BEFORE INSERT OR UPDATE OF organization_id, status ON public.warehouses
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_assert_parent_not_archived_v1('not_archived');

DROP TRIGGER IF EXISTS distribution_points_parent_not_archived_trg ON public.distribution_points;
CREATE TRIGGER distribution_points_parent_not_archived_trg
  BEFORE INSERT OR UPDATE OF organization_id, status ON public.distribution_points
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_assert_parent_not_archived_v1('not_archived');

DROP TRIGGER IF EXISTS qr_tokens_parent_not_archived_trg ON public.qr_tokens;
CREATE TRIGGER qr_tokens_parent_not_archived_trg
  BEFORE INSERT OR UPDATE OF organization_id, status ON public.qr_tokens
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_assert_parent_not_archived_v1('active_only');

DROP TRIGGER IF EXISTS item_availability_parent_not_archived_trg ON public.item_availability;
CREATE TRIGGER item_availability_parent_not_archived_trg
  BEFORE INSERT OR UPDATE OF organization_id ON public.item_availability
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_assert_parent_not_archived_v1('any');

-- ----------------------------------------------------------------------------
-- 5. verification — fail closed before COMMIT.
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_trigger_def text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organizations'
      AND column_name = 'archived_at' AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (202): organizations.archived_at is missing, non-nullable, or has a default';
  END IF;

  SELECT pg_get_triggerdef(oid) INTO v_trigger_def
    FROM pg_trigger WHERE tgname = 'organizations_archive_dependency_guard_trg';
  IF v_trigger_def IS NULL OR v_trigger_def NOT ILIKE '%OF status, archived_at%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (202): the archive guard trigger is not widened to OF status, archived_at';
  END IF;
  IF v_trigger_def NOT ILIKE '%INSERT%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (202): the archive guard trigger does not also fire on INSERT (archived_at INSERT-path forgery would be unguarded)';
  END IF;

  IF to_regprocedure('public._phoenix_assert_parent_not_archived_v1()') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (202): the reciprocal guard function is absent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM aclexplode((
      SELECT proacl FROM pg_proc WHERE oid = to_regprocedure('public._phoenix_assert_parent_not_archived_v1()')
    ))
    WHERE grantee = 0 AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (202): PUBLIC (grantee OID 0) still has EXECUTE on the reciprocal guard';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'warehouses_parent_not_archived_trg') THEN
    RAISE EXCEPTION 'VERIFY FAILED (202): the warehouses reciprocal guard is not attached';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'distribution_points_parent_not_archived_trg') THEN
    RAISE EXCEPTION 'VERIFY FAILED (202): the distribution_points reciprocal guard is not attached';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'qr_tokens_parent_not_archived_trg') THEN
    RAISE EXCEPTION 'VERIFY FAILED (202): the qr_tokens reciprocal guard is not attached';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'item_availability_parent_not_archived_trg') THEN
    RAISE EXCEPTION 'VERIFY FAILED (202): the item_availability reciprocal guard is not attached';
  END IF;
END;
$verify$;

COMMIT;

-- ============================================================================
-- ROLLBACK — must run in this exact order: restore the archive guard
-- function's body BEFORE dropping archived_at, or the function retains a
-- dangling column reference and every future organization status update
-- fails at runtime.
--
--   BEGIN;
--   DROP TRIGGER IF EXISTS warehouses_parent_not_archived_trg ON public.warehouses;
--   DROP TRIGGER IF EXISTS distribution_points_parent_not_archived_trg ON public.distribution_points;
--   DROP TRIGGER IF EXISTS qr_tokens_parent_not_archived_trg ON public.qr_tokens;
--   DROP TRIGGER IF EXISTS item_availability_parent_not_archived_trg ON public.item_availability;
--   DROP FUNCTION IF EXISTS public._phoenix_assert_parent_not_archived_v1();
--
--   CREATE OR REPLACE FUNCTION public._phoenix_organization_archive_dependency_guard_v1()
--   RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
--   SET search_path TO 'public', 'pg_temp'
--   AS $function$
--   DECLARE
--     v_warehouses          bigint;
--     v_distribution_points bigint;
--     v_qr_tokens           bigint;
--     v_item_availability   bigint;
--   BEGIN
--     IF NEW.status IS DISTINCT FROM 'inactive' OR OLD.status IS NOT DISTINCT FROM 'inactive' THEN
--       RETURN NEW;
--     END IF;
--     PERFORM 1 FROM public.organizations WHERE id = NEW.id FOR UPDATE;
--     SELECT count(*) INTO v_warehouses FROM public.warehouses
--      WHERE organization_id = NEW.id AND status <> 'archived';
--     SELECT count(*) INTO v_distribution_points FROM public.distribution_points
--      WHERE organization_id = NEW.id AND status <> 'archived';
--     SELECT count(*) INTO v_qr_tokens FROM public.qr_tokens
--      WHERE organization_id = NEW.id AND status = 'active';
--     SELECT count(*) INTO v_item_availability FROM public.item_availability
--      WHERE organization_id = NEW.id;
--     IF v_warehouses > 0 OR v_distribution_points > 0 OR v_qr_tokens > 0 OR v_item_availability > 0 THEN
--       RAISE EXCEPTION 'organization_archive_blocked_by_dependencies'
--         USING ERRCODE = '23514',
--         DETAIL = format('warehouses=%s distribution_points=%s qr_tokens=%s item_availability=%s',
--           v_warehouses, v_distribution_points, v_qr_tokens, v_item_availability),
--         HINT = 'Clear or archive the organization''s warehouses, outlets, active QR tokens and availability rows before archiving it.';
--     END IF;
--     RETURN NEW;
--   END;
--   $function$;
--
--   DROP TRIGGER IF EXISTS organizations_archive_dependency_guard_trg ON public.organizations;
--   CREATE TRIGGER organizations_archive_dependency_guard_trg
--     BEFORE UPDATE OF status ON public.organizations
--     FOR EACH ROW EXECUTE FUNCTION public._phoenix_organization_archive_dependency_guard_v1();
--
--   ALTER TABLE public.organizations DROP COLUMN archived_at;
--   COMMIT;
-- ============================================================================
