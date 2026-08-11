-- ============================================================================
-- P0 HOTFIX (178) — DISTRIBUTION POINT OWNER-GUARD PRIVILEGE FIX
--
-- SYMPTOM (live Production): creating a distribution point/outlet from
-- Institution Management fails for every authenticated caller — including a
-- real application super_admin — with
--   SQLSTATE 42501  permission denied for table warehouses
--
-- ROOT CAUSE: Migration 171's outlet guard,
--   public._phoenix_distribution_points_owner_kind_guard_v1()
-- was created WITHOUT an explicit security context, so it runs SECURITY
-- INVOKER. Its first statement takes a row lock:
--   SELECT organization_id INTO v_owner_org
--   FROM public.warehouses WHERE id = NEW.warehouse_id
--   FOR SHARE;
-- In PostgreSQL a locking read (FOR SHARE / FOR UPDATE / FOR NO KEY UPDATE /
-- FOR KEY SHARE) requires more than SELECT: the caller needs UPDATE (or
-- DELETE) on the table. Production grants `authenticated` SELECT on
-- public.warehouses but NOT UPDATE, so the guard aborts with 42501 before it
-- can evaluate anything — the INSERT never reaches the business rule, and the
-- failure is indistinguishable at the UI from a permissions problem.
--
-- The RLS INSERT policy on distribution_points was never the blocker: a
-- super_admin already satisfies it. Proven on a disposable 001->177 rig under
-- real authenticated-role semantics: with `warehouses` UPDATE revoked, a plain
-- SELECT succeeds while the same SELECT ... FOR SHARE returns 42501, and the
-- outlet INSERT fails identically.
--
-- WHY THIS FIX
--   * The FOR SHARE lock is NOT removable. Migration 171 deliberately built a
--     two-sided serialization: the warehouse guard takes FOR UPDATE on the
--     warehouse row during reassignment, this guard takes FOR SHARE on the same
--     row while attaching an outlet. Those conflict, so an authority-owned
--     warehouse can never end up holding an outlet via a concurrent interleave.
--     Dropping the lock to silence the ACL error would reopen that race.
--   * Granting `authenticated` UPDATE on public.warehouses is rejected: it
--     hands every authenticated user table-wide write capability merely so an
--     internal guard can take a read lock — enormously broader than required.
--   * SECURITY DEFINER on this one internal trigger function is the smallest
--     correct repair. The guard needs the owner's privileges only to read and
--     briefly lock one warehouse row it already knows the id of.
--
-- SECURITY DEFINER also makes the guard STRICTER, not weaker. Under INVOKER
-- the two lookups were subject to the caller's RLS visibility: a caller who
-- could not see the warehouse (or its organization) row would read NULL, land
-- in `v_owner_kind IS NULL`, and be waved through — silently permitting the
-- exact outlet the rule exists to forbid. Reading as the definer means the
-- ownership test is always evaluated against real committed state.
--
-- SCOPE: one function attribute. No table/RLS/policy/index/grant changes, no
-- role changes, no permission-matrix changes, no stock or business-rule
-- changes. Migration 171 is NOT edited; the body below is byte-identical to
-- 171's apart from the added SECURITY DEFINER. search_path stays exactly
-- `public, pg_temp` as 171 set it — every object reference inside is already
-- schema-qualified, so the trailing pg_temp cannot shadow them.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.warehouses') IS NULL
     OR to_regclass('public.organizations') IS NULL
     OR to_regclass('public.distribution_points') IS NULL THEN
    RAISE EXCEPTION '178 preflight failed: required tables missing';
  END IF;

  IF to_regprocedure('public._phoenix_distribution_points_owner_kind_guard_v1()') IS NULL THEN
    RAISE EXCEPTION '178 preflight failed: Migration-171 outlet guard function missing';
  END IF;

  -- The trigger must already exist and already point at this function: 178
  -- repairs 171's guard, it never installs a new enforcement point.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE c.relname = 'distribution_points'
      AND t.tgname = 'distribution_points_owner_kind_guard_trg'
      AND p.proname = '_phoenix_distribution_points_owner_kind_guard_v1'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION '178 preflight failed: 171 outlet guard trigger is not installed as expected';
  END IF;

  -- The paired warehouse-side guard must still be present: 178 relies on it for
  -- the other half of 171's serialization contract and must not be applied to a
  -- database where that half has gone missing.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'warehouses'
      AND t.tgname = 'warehouses_owner_kind_guard_trg'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION '178 preflight failed: paired warehouse owner-kind guard missing';
  END IF;
END;
$preflight$;

-- Body byte-identical to Migration 171's, plus SECURITY DEFINER. CREATE OR
-- REPLACE preserves the existing owner and the existing trigger attachment.
CREATE OR REPLACE FUNCTION public._phoenix_distribution_points_owner_kind_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_owner_org  uuid;
  v_owner_kind text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.warehouse_id IS NOT DISTINCT FROM OLD.warehouse_id THEN
    RETURN NEW;
  END IF;

  -- Two separate steps, deliberately not one JOINed query: FOR SHARE on a
  -- single-table scan of warehouses is the well-tested case for EvalPlanQual
  -- (Postgres's concurrent-update re-check) to correctly re-fetch the LATEST
  -- committed organization_id once unblocked. Reading organizations afterward,
  -- as its own plain (unlocked) statement, then always sees whichever
  -- organization_id step 1 just resolved. FOR SHARE here conflicts with the
  -- warehouse guard's FOR UPDATE, giving the two-sided serialization 171
  -- established. This lock is load-bearing — do not remove it.
  SELECT organization_id INTO v_owner_org
  FROM public.warehouses WHERE id = NEW.warehouse_id
  FOR SHARE;

  SELECT organization_kind INTO v_owner_kind
  FROM public.organizations WHERE id = v_owner_org;

  IF v_owner_kind = 'pharmacy_department_authority' THEN
    RAISE EXCEPTION 'pharmacy_department_authority_warehouse_no_outlets' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$fn$;

-- Defense in depth for the new SECURITY DEFINER context. A RETURNS trigger
-- function cannot be invoked directly anyway (PostgreSQL rejects it with
-- "trigger functions can only be called as triggers"), and PostgreSQL does not
-- consult EXECUTE on a trigger function when firing it, so removing the default
-- PUBLIC grant closes the direct-call surface without touching the trigger.
REVOKE ALL ON FUNCTION public._phoenix_distribution_points_owner_kind_guard_v1()
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_distribution_points_owner_kind_guard_v1() IS
  'P0 HOTFIX 178: Migration-171 outlet owner-kind guard, now SECURITY DEFINER. Its FOR SHARE row lock on public.warehouses is a locking read, which PostgreSQL only permits with UPDATE/DELETE privilege; authenticated holds SELECT only, so under SECURITY INVOKER every outlet creation failed with 42501 before the business rule was ever evaluated. Running as the definer restores creation without granting any table privilege, preserves 171''s two-sided FOR SHARE/FOR UPDATE serialization, and makes the ownership test immune to caller RLS visibility.';

DO $verify$
DECLARE
  v_secdef  boolean;
  v_config  text[];
  v_body    text;
  v_owner   text;
BEGIN
  SELECT p.prosecdef, p.proconfig, p.prosrc, pg_get_userbyid(p.proowner)
    INTO v_secdef, v_config, v_body, v_owner
  FROM pg_proc p
  WHERE p.oid = 'public._phoenix_distribution_points_owner_kind_guard_v1()'::regprocedure;

  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION '178 verify failed: outlet guard is not SECURITY DEFINER';
  END IF;

  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION '178 verify failed: outlet guard lost its explicit search_path';
  END IF;

  -- The row lock is the whole point of 171's concurrency contract. If a future
  -- edit silences the ACL error by deleting the lock instead, fail closed here.
  IF v_body NOT LIKE '%FOR SHARE%' THEN
    RAISE EXCEPTION '178 verify failed: the FOR SHARE row lock was removed';
  END IF;

  -- The business rule itself must survive verbatim.
  IF v_body NOT LIKE '%pharmacy_department_authority_warehouse_no_outlets%' THEN
    RAISE EXCEPTION '178 verify failed: authority-warehouse outlet rule is gone';
  END IF;

  -- The definer must actually be able to read/lock what the guard needs.
  IF NOT has_table_privilege(v_owner, 'public.warehouses', 'SELECT')
     OR NOT has_table_privilege(v_owner, 'public.warehouses', 'UPDATE')
     OR NOT has_table_privilege(v_owner, 'public.organizations', 'SELECT') THEN
    RAISE EXCEPTION '178 verify failed: definer % cannot read/lock the tables the guard requires', v_owner;
  END IF;

  -- 178 must never be the reason anonymous access appears anywhere.
  IF has_function_privilege('anon', 'public._phoenix_distribution_points_owner_kind_guard_v1()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '178 verify failed: anon retains EXECUTE on the internal guard';
  END IF;

  -- Both halves of 171's serialization contract must still be attached.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'distribution_points'
      AND t.tgname = 'distribution_points_owner_kind_guard_trg' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION '178 verify failed: outlet guard trigger detached';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'warehouses'
      AND t.tgname = 'warehouses_owner_kind_guard_trg' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION '178 verify failed: paired warehouse guard trigger detached';
  END IF;
END;
$verify$;

COMMIT;
