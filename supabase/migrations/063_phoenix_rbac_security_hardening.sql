-- =============================================================================
-- MediStock Phoenix V2 — Migration 063: RBAC Security Hardening (privilege-only)
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
--
-- RBAC-SECURITY-HARDENING-CHECKPOINT-063-A
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES
-- ─────────────────────────────────────────────────────────────────────────────
--   Records — for every future environment — two already-approved security
--   corrections that were applied by hand to production immediately after
--   migration 062 was verified (verdict READY_FOR_RBAC_ACTIVATION, 14/14 gates
--   PASS). It changes PRIVILEGES ONLY. It creates nothing, drops nothing, alters
--   no table, function body, trigger or RLS policy, and grants nothing back.
--
--   1. Trigger-function ACL hardening. Migration 062 hardened its three
--      APPLICATION scope helpers (REVOKE ALL FROM PUBLIC, anon; GRANT EXECUTE TO
--      authenticated) but issued no ACL statement for its three TRIGGER-ONLY
--      functions, so each kept PostgreSQL's CREATE FUNCTION default GRANT EXECUTE
--      TO PUBLIC. This revokes that default from PUBLIC, anon and authenticated.
--
--   2. Anonymous table-access hardening. profile_permission_overrides is an
--      internal permission table (RLS-protected, three-state role opinions). It
--      is never read by the anonymous role in any product path, so its residual
--      historical anon SELECT grant is removed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY REVOKING THE TRIGGER FUNCTIONS IS SAFE (trigger-only, never RPCs)
-- ─────────────────────────────────────────────────────────────────────────────
--   All three are `RETURNS trigger`, take ZERO arguments, and are each bound to
--   exactly one row-level trigger created by migration 062:
--     phoenix_validate_profile_scope_assignment()  <- trg_validate_profile_scope_assignment
--       (BEFORE INSERT OR UPDATE ON public.profile_scope_assignments)
--     phoenix_protect_last_super_admin()            <- trg_protect_last_super_admin
--       (BEFORE UPDATE OR DELETE ON public.profiles)
--     phoenix_validate_ppo_scope()                  <- trg_validate_ppo_scope
--       (BEFORE INSERT OR UPDATE ON public.profile_permission_overrides)
--   A function returning `trigger` cannot be invoked as an ordinary SQL/RPC call
--   (PostgreSQL raises "trigger functions can only be called as triggers",
--   SQLSTATE 0A000), and Supabase/PostgREST never exposes such a function as a
--   callable endpoint. Trigger firing does NOT consult EXECUTE privilege on the
--   function, and all three are SECURITY DEFINER (they already run as the owner).
--   Removing EXECUTE from PUBLIC/anon/authenticated therefore closes an
--   unnecessary grant with ZERO functional impact: the triggers keep firing and
--   the owner (and superusers) can still maintain the functions.
--
--   The three APPLICATION helpers are deliberately NOT touched here — migration
--   062 already granted authenticated EXECUTE on them and that grant must remain:
--     phoenix_profile_has_scoped_permission(uuid, text, uuid, uuid, uuid)
--     phoenix_profile_has_warehouse_assignment(uuid, uuid)
--     phoenix_profile_has_point_assignment(uuid, uuid)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- IDEMPOTENCY
-- ─────────────────────────────────────────────────────────────────────────────
--   REVOKE is naturally idempotent: revoking a privilege that is already absent
--   is a no-op and raises nothing, so this migration may be re-applied safely and
--   converges every environment to the same hardened ACL state. It requires
--   migrations 001–062 to be applied first (the four objects below must exist).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
--   • Does NOT modify migrations 001–062 in any way.
--   • Does NOT create, drop, or alter any table, column, index, constraint,
--     function body, trigger or RLS policy.
--   • Does NOT grant any replacement privilege to anyone.
--   • Does NOT revoke anything from the three application scope helpers.
--   • Does NOT change public.warehouses' historical anonymous SELECT behavior
--     (that access predates this domain, RLS is enabled, and every warehouse
--     SELECT policy is TO authenticated, so anon still reads no row) — it is left
--     exactly as migrations 060/062 left it and is NOT named here.
--   • Does NOT create any user-administration or dispatch RPC (that remains a
--     separate, future concern).
--   • Does NOT DELETE, TRUNCATE or DROP anything.
-- =============================================================================

BEGIN;

REVOKE ALL ON FUNCTION
  public.phoenix_protect_last_super_admin()
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.phoenix_validate_ppo_scope()
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.phoenix_validate_profile_scope_assignment()
FROM PUBLIC, anon, authenticated;

REVOKE SELECT
ON TABLE public.profile_permission_overrides
FROM anon;

COMMIT;

-- =============================================================================
-- END OF MIGRATION 063
--
-- POST-APPLY VERIFICATION (run manually, read-only, one block at a time)
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. No PUBLIC/anon/authenticated EXECUTE remains on the three trigger functions:
--      SELECT p.proname,
--             has_function_privilege('anon',          p.oid, 'EXECUTE')  AS anon_exec,
--             has_function_privilege('authenticated', p.oid, 'EXECUTE')  AS auth_exec
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public'
--        AND p.proname IN ('phoenix_protect_last_super_admin',
--                          'phoenix_validate_ppo_scope',
--                          'phoenix_validate_profile_scope_assignment');
--    -- expect anon_exec = f and auth_exec = f for all three.
--
-- 2. authenticated EXECUTE is still granted on the three application helpers:
--      SELECT has_function_privilege('authenticated',
--        'public.phoenix_profile_has_scoped_permission(uuid, text, uuid, uuid, uuid)'::regprocedure, 'EXECUTE');
--      -- expect true (unchanged by this migration).
--
-- 3. anon no longer holds SELECT on profile_permission_overrides:
--      SELECT count(*) FROM information_schema.role_table_grants
--      WHERE table_schema = 'public' AND table_name = 'profile_permission_overrides'
--        AND grantee = 'anon';
--      -- expect 0.
--
-- 4. The three triggers remain enabled and bound (unchanged by this migration):
--      SELECT tgname, tgenabled FROM pg_trigger
--      WHERE tgname IN ('trg_validate_profile_scope_assignment',
--                       'trg_protect_last_super_admin','trg_validate_ppo_scope')
--        AND NOT tgisinternal;
--      -- expect all three present with tgenabled = 'O'.
-- =============================================================================
