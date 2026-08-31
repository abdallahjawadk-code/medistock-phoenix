-- ============================================================================
-- MEDISTOCK PHOENIX v2.1 — ORGANIZATION ARCHIVE DEPENDENCY GUARD — 201
--
-- Fixes ISW1-D1: an organization can be archived while its operational
-- dependencies are still live, because NOTHING in the database enforces the
-- archive-safety contract. The contract lived only in the browser.
--
-- CONFIRMED EVIDENCE (IS-W1 UAT, artifacts 357-359, two controlled
-- reproductions in independent browser contexts):
--     getOrgDeleteImpact() consumed every count as `res.count ?? 0` and never
--     inspected `res.error`, so a failed safety read became a legitimate zero.
--     With all four gating counts faulted the wizard offered the archive
--     action and the server accepted it:
--
--       PATCH /rest/v1/organizations?id=eq.<org>   ->   204
--       organizations.status = 'inactive'
--       warehouses = 1, distribution_points = 2, qr_tokens(active) = 1,
--       item_availability = 2                      -- ALL STILL LIVE
--
-- ROOT CAUSE (server half)
--   public.organizations carried four triggers and none of them guarded
--   archiving:
--     set_updated_at                                   -- timestamps
--     organizations_institution_class_immutable_trg    -- immutability
--     organizations_kind_immutable_trg                 -- immutability
--     organizations_health_sector_activation_guard_trg -- fires only when
--                                                         NEW.status='active'
--   public.archive_entity(text,uuid,text) allowlists only warehouse,
--   distribution_point and local_item, so an organization cannot even reach a
--   guarded RPC. The frontend's archiveOrganization() issues a bare PostgREST
--   UPDATE, so ANY client — the Product UI, curl, a script, another app — could
--   archive an organization holding live dependencies.
--
-- WHAT THIS MIGRATION DOES
--   Adds ONE BEFORE UPDATE OF status trigger that refuses any transition INTO
--   'inactive' while canonical blocking dependencies exist. Because it lives on
--   the table, it protects every path uniformly: Product UI, direct REST PATCH,
--   RPC, and any future client. RLS is unchanged and still decides WHO may
--   attempt the update; this decides WHETHER the update is legal at all.
--
-- CANONICAL BLOCKING DEPENDENCIES
--   Exactly the four classes the established Product contract already uses for
--   canArchive in src/shared/supabase/services/lifecycle.service.ts, filter for
--   filter, so the server and the UI can never disagree about what blocks:
--     warehouses           organization_id = org AND status <> 'archived'
--     distribution_points  organization_id = org AND status <> 'archived'
--     qr_tokens            organization_id = org AND status = 'active'
--     item_availability    organization_id = org
--   profiles and institution_item_status_reports are deliberately NOT blocking:
--   the Product contract treats users as safe across an archive (dw_users_safe)
--   and they feed canPurge, never canArchive.
--
-- WHY SECURITY DEFINER
--   The guard must count dependencies the CALLER may not be able to see. A
--   caller whose RLS view of warehouses or item_availability is narrower than
--   reality would otherwise produce a short count and the guard would pass —
--   reintroducing the same fail-open this migration exists to close. SECURITY
--   DEFINER makes the count authoritative rather than caller-relative. It is
--   NOT used to bypass an RLS error: the UPDATE itself is still fully subject
--   to orgs_all_superadmin, so an unauthorized caller is refused exactly as
--   before and never reaches this function. Every object is schema-qualified,
--   search_path is pinned, and EXECUTE is revoked from PUBLIC.
--
-- CONCURRENCY — WHY ONE GUARD IS NOT ENOUGH
--   `UPDATE organizations SET status=...` takes FOR NO KEY UPDATE on the row,
--   which DELIBERATELY does not conflict with the FOR KEY SHARE a child
--   INSERT's foreign key takes — that is exactly what those lock modes are for.
--   Counting without more would therefore leave a window in which a dependency
--   commits between the count and the archive, so the guard takes an explicit
--   FOR UPDATE on the organization row BEFORE counting.
--
--   That fence alone is still NOT the invariant, and this was proved rather
--   than assumed. Serialization only makes the count TRUE AT DECISION TIME; it
--   does not stop the loser of the race from landing afterwards:
--
--     A: BEGIN; UPDATE organizations SET status='inactive'  -- fence, count 0
--     B: UPDATE qr_tokens SET status='active' WHERE id=...   -- no FK re-check,
--                                                            -- nothing locks
--                                                            -- organizations
--     A: COMMIT;                                             -- archived
--     B: commits                                             -- token now live
--
--   Final state: an archived organization holding a live dependency — the exact
--   outcome ISW1-D1 exists to prevent. The same happens to a WAREHOUSE insert,
--   which DOES block on the fence but then simply proceeds once the archive
--   commits. An in-place status flip is worse still: organization_id never
--   changes, so no foreign key check runs and nothing touches organizations at
--   all.
--
--   The invariant therefore needs BOTH halves, and this migration ships both:
--     1. an organization may not be archived while dependencies are live;
--     2. a dependency may not be created or made live under an ALREADY archived
--        organization.
--   Each half takes the same organization-row lock, so the two orderings are
--   symmetric: whichever transaction commits second sees the other's effect and
--   is refused. Reactivate the organization first, then its dependencies.
-- ============================================================================

BEGIN;

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
  -- Only a transition INTO 'inactive' is an archive. Re-archiving an already
  -- inactive organization, activation, suspension and every unrelated column
  -- update are left exactly as they were.
  IF NEW.status IS DISTINCT FROM 'inactive' OR OLD.status IS NOT DISTINCT FROM 'inactive' THEN
    RETURN NEW;
  END IF;

  -- Serialization fence -- see CONCURRENCY above. The row is already locked by
  -- the UPDATE, but only FOR NO KEY UPDATE; this upgrades it so a concurrent
  -- dependency INSERT cannot slip past the count.
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

  RETURN NEW;
END;
$function$;

-- The function is reachable only through the trigger below. PostgreSQL does not
-- check EXECUTE on trigger functions for the triggering statement, so removing
-- the PUBLIC grant costs nothing and keeps the surface closed (M197 contract).
REVOKE ALL ON FUNCTION public._phoenix_organization_archive_dependency_guard_v1() FROM PUBLIC;

DROP TRIGGER IF EXISTS organizations_archive_dependency_guard_trg ON public.organizations;

CREATE TRIGGER organizations_archive_dependency_guard_trg
  BEFORE UPDATE OF status ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_organization_archive_dependency_guard_v1();

-- ---------------------------------------------------------------------------
-- HALF TWO — the reciprocal rule, without which half one is defeatable purely
-- by ordering (see CONCURRENCY above). A dependency may not be created, moved
-- into, or made live under an organization that is already archived.
--
-- SECURITY DEFINER for the same reason as half one: the organization's status
-- must be read authoritatively, not through the caller's RLS view. It grants
-- nothing — the INSERT/UPDATE itself remains fully subject to the dependency
-- table's own RLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_archived_organization_dependency_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_live       boolean;
  v_org_status    text;
BEGIN
  -- "Live" is defined exactly as the archive guard counts it, table by table,
  -- so the two halves can never disagree about what blocks an archive.
  --
  -- Written as branches rather than one CASE expression on purpose:
  -- item_availability has no `status` column, and a single SQL CASE resolves
  -- every field reference in it, so naming NEW.status anywhere in that
  -- expression fails on that table with `record "new" has no field "status"`.
  -- PL/pgSQL prepares each branch lazily, so a branch never taken is never
  -- resolved.
  IF TG_TABLE_NAME = 'item_availability' THEN
    -- Every row counts toward the archive contract; there is no liveness flag.
    v_is_live := true;
  ELSIF TG_TABLE_NAME = 'qr_tokens' THEN
    v_is_live := (NEW.status = 'active');
  ELSIF TG_TABLE_NAME IN ('warehouses', 'distribution_points') THEN
    v_is_live := (NEW.status IS DISTINCT FROM 'archived');
  ELSE
    v_is_live := false;
  END IF;

  IF NOT v_is_live THEN
    RETURN NEW;
  END IF;

  -- The same organization-row fence the archive guard takes, from the other
  -- side. FOR SHARE conflicts with that guard's FOR UPDATE, so the two can
  -- never both decide against a stale view of each other.
  SELECT o.status INTO v_org_status
    FROM public.organizations o
   WHERE o.id = NEW.organization_id
     FOR SHARE;

  -- No row yet: the foreign key raises its own, better error. Never mask it.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_org_status = 'inactive' THEN
    RAISE EXCEPTION 'organization_archived_dependency_not_permitted'
      USING ERRCODE = '23514',
      DETAIL = format(
        '%s cannot be created or made live while organization %s is archived',
        TG_TABLE_NAME, NEW.organization_id
      ),
      HINT = 'Reactivate the organization before adding or reactivating its warehouses, outlets, QR tokens or availability rows.';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._phoenix_archived_organization_dependency_guard_v1() FROM PUBLIC;

-- Column lists keep the guard off every write that cannot change liveness or
-- ownership: a rename, a note, a quantity edit never pays for this check.
DROP TRIGGER IF EXISTS warehouses_archived_org_guard_trg ON public.warehouses;
CREATE TRIGGER warehouses_archived_org_guard_trg
  BEFORE INSERT OR UPDATE OF status, organization_id ON public.warehouses
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_archived_organization_dependency_guard_v1();

DROP TRIGGER IF EXISTS distribution_points_archived_org_guard_trg ON public.distribution_points;
CREATE TRIGGER distribution_points_archived_org_guard_trg
  BEFORE INSERT OR UPDATE OF status, organization_id ON public.distribution_points
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_archived_organization_dependency_guard_v1();

DROP TRIGGER IF EXISTS qr_tokens_archived_org_guard_trg ON public.qr_tokens;
CREATE TRIGGER qr_tokens_archived_org_guard_trg
  BEFORE INSERT OR UPDATE OF status, organization_id ON public.qr_tokens
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_archived_organization_dependency_guard_v1();

-- item_availability has no liveness status in the archive contract — every row
-- counts — so only creation or a change of owner can grow that count.
DROP TRIGGER IF EXISTS item_availability_archived_org_guard_trg ON public.item_availability;
CREATE TRIGGER item_availability_archived_org_guard_trg
  BEFORE INSERT OR UPDATE OF organization_id ON public.item_availability
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_archived_organization_dependency_guard_v1();

COMMIT;
