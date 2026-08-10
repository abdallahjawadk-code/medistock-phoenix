-- ============================================================================
-- DATABASE-SECURITY-SURFACE-HARDENING-173  (post-Stage-F, finding C1)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 172, via the Supabase SQL Editor, after reading this file in
-- full.
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-172 are immutable and are NOT edited here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE FINDING (C1)
-- ─────────────────────────────────────────────────────────────────────────────
-- public.get_profile_identity_snapshot(uuid) — added by Migration 013 as a
-- helper "for use by future write paths" (docs/user-identity-snapshot-plan.md)
-- and return-type-corrected by 064 — is a SECURITY DEFINER function that:
--
--   * takes a caller-supplied p_profile_id and returns that profile's
--     full_name, email, role and organization_id;
--   * performs NO authorization of any kind — no auth.uid() check, no
--     self check, no organization scope, no role gate;
--   * was granted EXECUTE to `authenticated` by 013, and — because no
--     REVOKE ... FROM PUBLIC was ever issued for it and this project has
--     never executed ALTER DEFAULT PRIVILEGES — also retains PostgreSQL's
--     default PUBLIC EXECUTE, which `anon` inherits.
--
-- The result is a cross-organization identity-disclosure primitive: anyone
-- holding a profile UUID can resolve that person's name, email, role and
-- organization, defeating the organization isolation the rest of this system
-- enforces rigorously.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A GRANT-ONLY FIX IS THE RIGHT ONE
-- ─────────────────────────────────────────────────────────────────────────────
-- A repository-wide sweep of src/, supabase/, edge functions, scripts/ and
-- tests/ finds NO runtime caller. Every reference is documentation, the two
-- migrations that define it, or tests that assert on migration SOURCE TEXT
-- (which a grant change cannot affect). It is also a leaf inside the database:
-- no other function, trigger, policy or view calls it.
--
-- So the function has no legitimate caller to preserve, and the minimal
-- remediation is to remove client reachability WITHOUT touching the object:
-- no body change, no signature change, no DROP/CREATE, no search_path change,
-- no SECURITY DEFINER change. Nothing that could regress a workflow is
-- touched, because the only thing that changes is who may invoke it.
--
-- Deliberately NOT done here:
--   * no other function's ACL is altered — the Phase-1 audit found a broader
--     pattern of un-revoked PUBLIC EXECUTE (~83 of ~266 functions), but that
--     set could not be resolved exactly without live catalog access, and
--     revoking on a suspicion is precisely how a working platform gets
--     broken. That is Phase 2, gated on read-only Production credentials.
--   * ALTER DEFAULT PRIVILEGES is NOT issued. It is prospective-only and
--     would silently change every future object's posture — a far wider
--     behavioural change than this finding justifies.
--   * public QR stays exactly as it is. get_public_qr_payload(text) is
--     intentionally anonymous and is asserted below, before and after, so
--     this migration can never be the thing that breaks it.
--   * no RLS, table, view, Auth-configuration or product change.
--
-- IF A SELF-IDENTITY RPC IS EVER WANTED, it should be a NEW function with an
-- explicit `auth.uid() = p_profile_id` gate — not a re-grant of this one.
-- ============================================================================

DO $hardening$
DECLARE
  v_target        text := 'public.get_profile_identity_snapshot(uuid)';
  v_qr            text := 'public.get_public_qr_payload(text)';
  v_def_before    text;
  v_def_after     text;
  v_prosecdef     boolean;
  v_config        text[];
  v_rettype       text;
  v_anon_before   boolean;
  v_auth_before   boolean;
  v_qr_anon       boolean;
  v_qr_auth       boolean;
BEGIN
  -- ══════════════════════════════════════════════════════════════════════════
  -- PREFLIGHT — fails closed, inside this transaction, before anything changes
  -- ══════════════════════════════════════════════════════════════════════════

  -- A. the exact target overload exists
  IF to_regprocedure(v_target) IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (173): % is absent', v_target;
  END IF;

  -- B/C/F. the object really is the one C1 describes — SECURITY DEFINER, the
  -- 013/064 identity-snapshot return contract, and 064's hardened search_path.
  -- If any of this differs, the function was replaced by something this
  -- migration has not reviewed, and revoking blindly would be irresponsible.
  SELECT p.prosecdef, p.proconfig, pg_get_function_result(p.oid)
    INTO v_prosecdef, v_config, v_rettype
  FROM pg_proc p
  WHERE p.oid = to_regprocedure(v_target);

  IF NOT v_prosecdef THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (173): % is no longer SECURITY DEFINER — unexpected replacement', v_target;
  END IF;

  IF v_rettype NOT LIKE '%identity_version%'
     OR v_rettype NOT LIKE '%full_name%'
     OR v_rettype NOT LIKE '%email%'
     OR v_rettype NOT LIKE '%role%'
     OR v_rettype NOT LIKE '%organization_id%' THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (173): % no longer returns the 013/064 identity snapshot contract', v_target;
  END IF;

  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (173): % lost 064''s explicit search_path — unexpected replacement', v_target;
  END IF;

  -- Body fingerprint, so VERIFY can prove this migration changed no code.
  v_def_before := pg_get_functiondef(to_regprocedure(v_target));

  -- The exposure this migration exists to remove must actually be present.
  -- (has_function_privilege resolves inherited PUBLIC grants too, which is
  --  exactly the reachability that matters here.)
  v_anon_before := has_function_privilege('anon', to_regprocedure(v_target), 'EXECUTE');
  v_auth_before := has_function_privilege('authenticated', to_regprocedure(v_target), 'EXECUTE');
  IF NOT (v_anon_before OR v_auth_before) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (173): % is already unreachable by anon and authenticated — nothing to harden, refusing to proceed blindly', v_target;
  END IF;

  -- D/E. public QR is intentionally anonymous and must survive untouched.
  IF to_regprocedure(v_qr) IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (173): % is absent', v_qr;
  END IF;
  v_qr_anon := has_function_privilege('anon', to_regprocedure(v_qr), 'EXECUTE');
  v_qr_auth := has_function_privilege('authenticated', to_regprocedure(v_qr), 'EXECUTE');
  IF NOT v_qr_anon THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (173): anon cannot already execute % — the public QR contract is not in its expected state', v_qr;
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- THE CHANGE — exactly one object, by exact signature, grants only
  -- ══════════════════════════════════════════════════════════════════════════
  REVOKE EXECUTE ON FUNCTION public.get_profile_identity_snapshot(uuid) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.get_profile_identity_snapshot(uuid) FROM anon;
  REVOKE EXECUTE ON FUNCTION public.get_profile_identity_snapshot(uuid) FROM authenticated;

  -- ══════════════════════════════════════════════════════════════════════════
  -- VERIFY — any failure raises and rolls the whole migration back
  -- ══════════════════════════════════════════════════════════════════════════

  -- A. still exists
  IF to_regprocedure(v_target) IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (173): % disappeared', v_target;
  END IF;

  -- B/C/D/E. body, signature, SECURITY DEFINER and search_path all unchanged.
  -- One definition comparison covers every one of them: pg_get_functiondef
  -- renders the name, argument list, return type, security attribute, SET
  -- clauses and body together.
  v_def_after := pg_get_functiondef(to_regprocedure(v_target));
  IF v_def_after IS DISTINCT FROM v_def_before THEN
    RAISE EXCEPTION 'VERIFY FAILED (173): the function definition changed — this migration must alter privileges only';
  END IF;

  -- F/G/H. no longer reachable from the API roles. anon inherits PUBLIC, so a
  -- false here also proves the PUBLIC grant is gone.
  IF has_function_privilege('anon', to_regprocedure(v_target), 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (173): anon can still execute %', v_target;
  END IF;
  IF has_function_privilege('authenticated', to_regprocedure(v_target), 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (173): authenticated can still execute %', v_target;
  END IF;

  -- I/J/K. public QR untouched — the single most important non-regression.
  IF to_regprocedure(v_qr) IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (173): % disappeared', v_qr;
  END IF;
  IF NOT has_function_privilege('anon', to_regprocedure(v_qr), 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (173): anon lost EXECUTE on % — public QR must remain anonymous', v_qr;
  END IF;
  IF has_function_privilege('authenticated', to_regprocedure(v_qr), 'EXECUTE') IS DISTINCT FROM v_qr_auth THEN
    RAISE EXCEPTION 'VERIFY FAILED (173): authenticated EXECUTE on % changed', v_qr;
  END IF;

  -- L. no unrelated ACL was modified. The three REVOKEs above name one exact
  -- overload, so this is a belt-and-braces check on the two neighbours most
  -- likely to be collateral damage: the target's sibling identity helpers.
  IF to_regprocedure('public.phoenix_my_role()') IS NOT NULL
     AND NOT has_function_privilege('authenticated', to_regprocedure('public.phoenix_my_role()'), 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (173): authenticated lost EXECUTE on phoenix_my_role() — out-of-scope ACL change';
  END IF;
END;
$hardening$;

-- ============================================================================
-- ROLLBACK GUIDANCE (documentation only — deliberately NOT executed)
--
-- This migration changes privileges on exactly one function overload and
-- writes no data, alters no structure and replaces no code. A pre-apply
-- failure leaves nothing behind: the whole file is one transaction.
--
-- To reverse a successful apply, restore ONLY the grant that provably existed
-- before it — Migration 013's:
--
--   GRANT EXECUTE ON FUNCTION public.get_profile_identity_snapshot(uuid)
--     TO authenticated;
--
-- The PUBLIC EXECUTE that also existed was PostgreSQL's implicit default for a
-- newly created function, never an explicit project grant. Re-issuing it would
-- be writing a new, speculative grant rather than restoring a reviewed one, so
-- it is deliberately NOT documented as a rollback step.
--
-- Reversal restores the pre-hardening exposure described under THE FINDING
-- above, and should only ever happen under explicit owner authorization.
-- ============================================================================
