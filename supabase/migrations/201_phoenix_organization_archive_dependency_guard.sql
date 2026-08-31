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
-- CONCURRENCY - WHAT THE FENCE DOES AND DOES NOT BUY
--   `UPDATE organizations SET status=...` takes FOR NO KEY UPDATE on the row,
--   which DELIBERATELY does not conflict with the FOR KEY SHARE a child
--   INSERT's foreign key takes - that is exactly what those lock modes are for.
--   Counting without more would therefore leave a window in which a dependency
--   commits between the count and the archive. The guard takes an explicit
--   FOR UPDATE on the organization row BEFORE counting, which does conflict
--   with FOR KEY SHARE. A dependency insert that overlaps the archive must
--   either commit first - and then be COUNTED, blocking the archive - or wait
--   behind the archive transaction.
--
--   So the archive DECISION is always made against a true, non-stale count.
--   That is the property this migration establishes, and it is precisely the
--   one the defect destroyed.
--
-- KNOWN RESIDUAL - recorded rather than papered over
--   This does NOT make "an archived organization never holds a live
--   dependency" a total invariant. A write that lands AFTER the archive
--   transaction commits can still create or reactivate a dependency
--   underneath an archived organization - either by waiting out the fence,
--   or, for qr_tokens, without touching organizations at all (an in-place
--   status flip changes no foreign key, and qr_tokens carries no trigger that
--   locks the parent). Both were reproduced on a real rig.
--
--   The reciprocal child-side rule that would close it - "no dependency may
--   become live under an archived organization" - is NOT implementable here.
--   public.organizations has no archived_at or equivalent, so status='inactive'
--   means BOTH "archived" and "built but not yet activated", and migration 181
--   depends on the second meaning: a health-sector organization is created
--   inactive and its ACTIVE warehouses, depots and facilities are inserted
--   underneath it before the activation guard validates the finished topology.
--   A blanket child-side rule refuses exactly that flow - proved by
--   181-closure-round1.dynamic.test.ts, which fails against it. Separating the
--   two meanings is a data-model change, out of scope for this repair, and is
--   recorded as its own finding rather than smuggled in here.
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

COMMIT;
