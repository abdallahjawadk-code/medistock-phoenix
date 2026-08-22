-- ============================================================================
-- AUTHORIZATION-SURFACE-REPRODUCIBILITY-CONVERGENCE-194
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 193.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION IS FOR
-- ─────────────────────────────────────────────────────────────────────────────
-- Production's authorization posture at ceiling 193 is CORRECT. The repository
-- could not REPRODUCE it. A fresh platform baseline replayed through 001→193
-- came out MORE PERMISSIVE than Production, in two independent ways. That is a
-- disaster-recovery defect: a rebuilt environment (restore rehearsal, staging
-- clone, new region, new project) would have silently come up with client-
-- reachable privileges Production does not grant.
--
-- Measured on a clean replay at 193 (effective privilege via has_*_privilege,
-- first-party objects in `public`, extension-owned objects excluded):
--
--   H-25  `authenticated` held 331 relation privilege tuples across 77
--         relations. Production holds 79 across 75. The 252-tuple excess is
--         INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER (184 tuples over 46
--         relations) plus MAINTAIN (68 relations) — all created BEFORE
--         migration 109, and among them `profiles`, `permission_keys`,
--         `role_permission_defaults`, `profile_permission_overrides`,
--         `profile_scope_assignments` and `audit_logs`: the RBAC and audit
--         tables themselves.
--
--   H-24  `authenticated` held EXECUTE on the two manual availability quantity
--         writers; Production does not. ROOT CAUSE, established by a live
--         read-only inspection of Production's migration history: Production
--         APPLIED migration 085, while tools/pg-rig/rig.mjs used to SKIP it.
--         That was a rig REPLAY-POLICY FIDELITY defect, not Production drift,
--         and it is fixed in the rig rather than here — the canonical replay
--         now applies 085 with its historical cutover attestation, so those
--         two grants are already absent before this migration runs. See the
--         085 section below.
--
-- ROOT CAUSE (not guessed — see migration 108's own analysis, which documents
-- the same mechanism): a real Supabase project is provisioned with
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES
--     TO authenticated, service_role;
-- Migration 108 revoked the excess on the 15 custody-chain tables it knew
-- about. Migration 109 closed the mechanism for the FUTURE. Neither could act
-- retroactively on every other object that already existed — `ALTER DEFAULT
-- PRIVILEGES` is prospective-only by Postgres design, and 108's list was
-- deliberately scoped to the custody chain. So 46 pre-109 relations kept
-- privileges nobody ever intended them to have.
--
-- This migration is the retroactive half that was missing. Responsibility
-- chain, unchanged and intentional:
--
--   bootstrap  platform initial ACL state (models Supabase provisioning)
--   001→108    historic Phoenix migrations (108 fixes 15 known tables)
--   109        locks FUTURE default privileges — IMMUTABLE, not touched here
--   110→193    normal hardened chain
--   194        retroactive convergence for LEGACY EXISTING objects + the
--              manual availability writer closure
--
-- ─────────────────────────────────────────────────────────────────────────────
-- RELATIONSHIP TO MIGRATION 085 — READ BEFORE ACTING ON EITHER
-- ─────────────────────────────────────────────────────────────────────────────
--   085_SOURCE_HEADER            = PREPARED_CUTOVER
--   085_PRODUCTION_HISTORY       = APPLIED_ONCE
--   085_PRODUCTION_SECURITY_EFFECT = LIVE
--   M194_WRITER_REVOKES          = IDEMPOTENT_REASSERTION_OF_EXISTING_085_SECURITY_BOUNDARY
--
-- These three facts coexist, and confusing them is what produced an earlier
-- wrong conclusion, so state them precisely:
--
--   * 085's SOURCE still reads "CUTOVER — PREPARED, DO NOT APPLY / MANUAL
--     APPLY ONLY", and still aborts unless the applying session sets
--     `phoenix.availability_cutover_attested`. That text is HISTORICAL SOURCE
--     STATE. It is not rewritten, and 085's bytes are not edited.
--
--   * Production nevertheless APPLIED it. A live read-only inspection of
--     `supabase_migrations.schema_migrations` records version 085,
--     `phoenix_revoke_manual_availability_writers`, count 1, with a stored
--     payload carrying both writer REVOKEs. The live functions carry 085's
--     own COMMENT text and show `authenticated` EXECUTE = NO,
--     `service_role` EXECUTE = YES.
--
--   * So 085's security effect is LIVE in Production, and has been all along.
--     The earlier claim that 085 was "prepared only, never applied" was FALSE
--     and must not be reintroduced anywhere.
--
-- WHAT THIS MIGRATION THEREFORE DOES *NOT* CLAIM: it does not supersede 085,
-- and it is not the mechanism that first closed those two writers — 085 is.
-- The reason a clean replay used to show the grants at all was that
-- tools/pg-rig/rig.mjs SKIPPED 085 while Production had applied it: a rig
-- replay-policy fidelity defect, now fixed in the rig by supplying the
-- historical attestation around that one apply.
--
-- WHAT THIS MIGRATION DOES KEEP: the same two REVOKE statements, as an
-- IDEMPOTENT REASSERTION of the final invariant. That is safe and deliberate —
-- Production already has them revoked, a corrected rig already has them
-- revoked after 085, and REVOKE of an absent privilege is a documented
-- Postgres no-op. They make 194 a self-contained statement of the contracted
-- end state rather than something that only holds if an earlier migration ran.
--
-- A FUTURE OPERATOR MUST NOT READ THIS MIGRATION AS PERMISSION TO APPLY 085
-- BY HAND. Production has already applied it; re-applying is unnecessary, and
-- 085's own fail-closed attestation gate still stands in front of it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SAFE IN BOTH DIRECTIONS — THIS IS AN AUTHORIZATION NO-OP ON PRODUCTION
-- ─────────────────────────────────────────────────────────────────────────────
-- Every statement below is written as a CONVERGENCE to an invariant, never as
-- a delta from an assumed starting state:
--
--   * the REVOKE is `ON ALL TABLES IN SCHEMA public`, so it does not need to
--     know which relations carry the excess, and revoking a privilege that was
--     never granted is a documented Postgres no-op;
--   * the two GRANTs restore exactly the contracted write surface, so they are
--     no-ops where it is already present;
--   * NO precondition requires the excess privileges to EXIST.
--
-- Applied to current Production (already hardened) the effective authorization
-- delta is empty. Applied to a corrected clean replay — one that includes
-- migration 085, as Production's history does — it removes exactly the 252
-- H-25 relation tuples above; the two writer REVOKEs are then idempotent
-- no-ops, because 085 already performed them. Both paths end at the same
-- contracted surface.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY EXACTLY TWO RELATIONS KEEP A DIRECT WRITE
-- ─────────────────────────────────────────────────────────────────────────────
-- Verified against Production's contract, the application source, and the RPC
-- architecture. Every other client mutation in this product goes through a
-- SECURITY DEFINER RPC that runs as the function owner, never as
-- `authenticated`, so no table grant is required for any of them.
--
-- A full parse of the product source for PostgREST direct-table writes
-- (`.from('<table>').insert/update/delete/upsert`) finds writes against
-- exactly four tables. Two are the contracted pair:
--     distribution_points  INSERT, UPDATE   (warehouses.service.ts)
--     organizations        INSERT, UPDATE   (organizations.service.ts,
--                                            lifecycle.service.ts)
-- The other two are DEAD EXPORTS with zero importers anywhere in the product:
--     audit_logs                       INSERT via writeAuditLog()
--     institution_item_status_reports  INSERT/UPDATE via createStatusReport(),
--                                      updateStatusReport(), resolveStatusReport()
-- Only the READ helpers from those two modules (getAuditLog, getStatusReports)
-- are imported by any screen, and existing regression tests already forbid a
-- screen from calling the writers at all (see
-- src/shared/ui/__tests__/nav-legacy-pages-hide.test.ts,
-- src/features/status/__tests__/status-center-live-matrix.test.ts,
-- src/features/reports/__tests__/audit-log-section.test.ts). Production
-- already denies both, so those paths are already non-functional there; this
-- migration does not change their reachability, it only makes a rebuilt
-- environment agree with Production about them.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- `MAINTAIN` IS PART OF THIS CONVERGENCE — WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- MAINTAIN (VACUUM / ANALYZE / CLUSTER / REINDEX / REFRESH MATERIALIZED VIEW)
-- is a real PostgreSQL 17 table privilege, and it is one of the privileges
-- `GRANT ALL ON TABLES` confers. The platform's project-provisioning default
-- therefore handed it to `authenticated` on every table created before
-- migration 109, exactly as it did the six data-write privileges — and none of
-- 108's or 109's REVOKE lists ever named it, because they predate it being
-- noticed.
--
-- LIVE Production verification at ceiling 193 measured:
--     authenticated MAINTAIN relations = 0
-- while a clean replay of this repository carried:
--     authenticated MAINTAIN relations = 68
--
-- So it is a genuine reproducibility gap of the same class as the rest of
-- H-25, not a cosmetic difference, and it is converged here rather than
-- excluded. A rebuilt environment must not hand a browser principal the
-- ability to REINDEX or VACUUM FULL an arbitrary table.
--
-- `service_role` KEEPS its MAINTAIN (82 relations) — it is the trusted server
-- identity and Production grants it. `anon` has none, before or after. SELECT
-- is untouched, as everywhere else in this migration.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. BEFORE-IMAGE — captured inside the transaction so the VERIFY section can
--    prove, on the live database rather than by assertion, that this migration
--    changed NOTHING it was not supposed to change.
-- ============================================================================

-- One definition of "the contracted authorization surface", materialized once
-- before the mutations and once after, so VERIFY compares like with like.
CREATE TEMP VIEW _m194_live_surface AS
WITH first_party_rel AS (
  SELECT c.oid, c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p','f')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
), first_party_seq AS (
  SELECT c.oid, c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'S'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
), first_party_fn AS (
  SELECT p.oid, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS ident
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
)
-- NOTE: every column is cast to `text` explicitly. Without this the UNION ALL
-- takes its result types from the FIRST branch, where relname is `name` — and
-- `name` is 63 characters, which silently TRUNCATES the function identity
-- signatures in the later branches and makes the before/after comparison
-- compare truncated strings.
SELECT 'RELATION'::text AS kind, r.rolname::text AS rolname,
       fr.relname::text AS object, pr.p::text AS privilege
  FROM pg_roles r CROSS JOIN first_party_rel fr
  CROSS JOIN (SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS p) pr
 WHERE r.rolname IN ('anon','authenticated','service_role')
   AND has_table_privilege(r.oid, fr.oid, pr.p)
UNION ALL
SELECT 'SEQUENCE', r.rolname, fs.relname, pr.p
  FROM pg_roles r CROSS JOIN first_party_seq fs
  CROSS JOIN (SELECT unnest(ARRAY['USAGE','SELECT','UPDATE']) AS p) pr
 WHERE r.rolname IN ('anon','authenticated','service_role')
   AND has_sequence_privilege(r.oid, fs.oid, pr.p)
UNION ALL
SELECT 'FUNCTION', r.rolname, ff.ident, 'EXECUTE'
  FROM pg_roles r CROSS JOIN first_party_fn ff
 WHERE r.rolname IN ('anon','authenticated','service_role')
   AND has_function_privilege(r.oid, ff.oid, 'EXECUTE')
UNION ALL
SELECT 'SCHEMA', r.rolname, 'public', pr.p
  FROM pg_roles r CROSS JOIN (SELECT unnest(ARRAY['USAGE','CREATE']) AS p) pr
 WHERE r.rolname IN ('anon','authenticated','service_role')
   AND has_schema_privilege(r.oid, 'public', pr.p);

CREATE TEMP TABLE _m194_before_surface ON COMMIT DROP AS
  SELECT * FROM _m194_live_surface;

-- Function identity/body/owner/config before-image, so VERIFY can prove that
-- no body, owner, search_path or security attribute moved.
CREATE TEMP TABLE _m194_before_functions ON COMMIT DROP AS
SELECT p.oid,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS ident,
       md5(p.prosrc)                       AS body_md5,
       p.prosecdef                         AS secdef,
       pg_get_userbyid(p.proowner)         AS owner,
       COALESCE(array_to_string(p.proconfig, ','), '') AS cfg
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public';

-- ============================================================================
-- 1. FAIL-CLOSED PRECONDITIONS
--
--    These prove this migration is executing against the ARCHITECTURE it was
--    reviewed against. None of them requires the H-24/H-25 excess privileges
--    to be present — that is deliberate, so an already-hardened Production
--    accepts this migration as an authorization no-op instead of aborting.
-- ============================================================================

DO $precond$
DECLARE
  v_upsert_oid    oid;
  v_movement_oid  oid;
  v_n             integer;
  v_md5           text;
BEGIN
  -- 1a. The two relations that legitimately keep a direct authenticated write.
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION 'M194 precondition failed: public.organizations is missing — this is not the reviewed schema';
  END IF;
  IF to_regclass('public.distribution_points') IS NULL THEN
    RAISE EXCEPTION 'M194 precondition failed: public.distribution_points is missing — this is not the reviewed schema';
  END IF;

  -- 1b. The replacement capability that made the manual writers redundant must
  --     already exist — the same guard migration 085 required before revoking
  --     them. Removing a capability with no replacement is not acceptable.
  IF to_regprocedure('public.phoenix_available_stock(uuid)') IS NULL THEN
    RAISE EXCEPTION 'M194 precondition failed: 083 phoenix_available_stock missing — the derived availability projection must exist before the manual writers are closed';
  END IF;
  IF to_regprocedure('public.phoenix_set_availability_visibility(uuid, boolean, text)') IS NULL THEN
    RAISE EXCEPTION 'M194 precondition failed: 084 phoenix_set_availability_visibility missing — the visibility setter must exist before the manual writers are closed';
  END IF;

  -- 1c. The two manual availability writers, by EXACT identity signature, with
  --     exactly one overload each (an unnoticed overload would survive the
  --     revoke and leave the boundary open).
  v_upsert_oid := to_regprocedure(
    'public.phoenix_upsert_availability(uuid,text,text,text,text,integer,text,date,text,text,text,numeric,text)');
  IF v_upsert_oid IS NULL THEN
    RAISE EXCEPTION 'M194 precondition failed: phoenix_upsert_availability(...) not found at the exact reviewed signature';
  END IF;
  v_movement_oid := to_regprocedure(
    'public.phoenix_apply_availability_movement(uuid,text,integer,text,text)');
  IF v_movement_oid IS NULL THEN
    RAISE EXCEPTION 'M194 precondition failed: phoenix_apply_availability_movement(...) not found at the exact reviewed signature';
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'phoenix_upsert_availability';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'M194 precondition failed: expected exactly 1 phoenix_upsert_availability overload, found %', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'phoenix_apply_availability_movement';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'M194 precondition failed: expected exactly 1 phoenix_apply_availability_movement overload, found %', v_n;
  END IF;

  -- 1d. Their bodies must be the reviewed bodies. This migration changes only
  --     privileges; if a body has drifted, the reviewed security analysis no
  --     longer applies and we must stop rather than revoke blind.
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_upsert_oid;
  IF v_md5 <> 'cf66c61734c5d1ecc2f54822efbb56ed' THEN
    RAISE EXCEPTION 'M194 precondition failed: phoenix_upsert_availability body md5 is % (expected cf66c61734c5d1ecc2f54822efbb56ed) — reviewed state has drifted', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_movement_oid;
  IF v_md5 <> '1229dfd36bebaac947f65c1852a9912d' THEN
    RAISE EXCEPTION 'M194 precondition failed: phoenix_apply_availability_movement body md5 is % (expected 1229dfd36bebaac947f65c1852a9912d) — reviewed state has drifted', v_md5;
  END IF;

  -- Both are SECURITY DEFINER internals and stay that way; service_role must
  -- already hold EXECUTE (trusted server identity) so that revoking
  -- `authenticated` cannot orphan the function.
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_upsert_oid)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_movement_oid) THEN
    RAISE EXCEPTION 'M194 precondition failed: a manual availability writer is not SECURITY DEFINER — reviewed state has drifted';
  END IF;
  IF NOT has_function_privilege('service_role', v_upsert_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_movement_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'M194 precondition failed: service_role must retain EXECUTE on both manual availability writers before authenticated is revoked';
  END IF;

  -- 1e. M193's hardened inter-organization alert command surface must be
  --     present and intact — it is the immediately preceding security state
  --     and this migration must not run on anything older or altered.
  IF to_regprocedure('public.phoenix_refresh_inter_org_alert_lifecycle(integer)') IS NULL
     OR to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state(integer)') IS NULL
     OR to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'M194 precondition failed: the M193 inter-org alert command surface is missing — apply 193 first';
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (p.proname, md5(p.prosrc)) IN (
       ('phoenix_refresh_inter_org_alert_lifecycle',                'a203286cb5c0075a4942b1307207076b'),
       ('phoenix_get_live_inter_institution_alerts_with_state',     '69104e1646a2e0203de6e2789ba54c7e'),
       ('phoenix_get_live_inter_institution_alerts_with_state_page','bf2b2295c55b4bc0a5dae074353250a3'))
     AND p.prosecdef
     AND COALESCE(array_to_string(p.proconfig, ','), '') = 'search_path=public, pg_temp';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'M194 precondition failed: expected 3 intact M193 SECURITY DEFINER functions with the reviewed bodies and search_path, found %', v_n;
  END IF;

  -- M193's own EXECUTE posture, which this migration must leave alone.
  IF NOT has_function_privilege('authenticated', 'public.phoenix_refresh_inter_org_alert_lifecycle(integer)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.phoenix_get_live_inter_institution_alerts_with_state(integer)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'M194 precondition failed: the M193 authenticated EXECUTE posture is not the reviewed one';
  END IF;

  -- 1f. The canonical authorization shape must be recognizable: the two
  --     contract relations are already readable by `authenticated` (proving
  --     the canonical GRANT chain ran), and service_role carries its platform
  --     baseline on `public`. Both are properties of a correctly built
  --     database, present in Production AND in a clean replay — neither
  --     depends on the excess this migration removes.
  IF NOT has_table_privilege('authenticated', 'public.organizations', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.distribution_points', 'SELECT') THEN
    RAISE EXCEPTION 'M194 precondition failed: authenticated cannot SELECT the contract relations — the canonical grant chain did not run';
  END IF;
  IF NOT has_schema_privilege('service_role', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'M194 precondition failed: service_role lacks USAGE on schema public — platform baseline is not in place';
  END IF;

  -- 1g. Sanity on the object population, so this cannot be run against an
  --     empty or partially-built database.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e');
  IF v_n < 300 THEN
    RAISE EXCEPTION 'M194 precondition failed: only % first-party functions in public — this is not a fully built schema', v_n;
  END IF;
END;
$precond$;

-- ============================================================================
-- 2. RELATION AUTHORIZATION CONVERGENCE (H-25)
--
--    Invariant, not a delta: strip every direct write from `authenticated` on
--    everything in `public`, then restore exactly the contracted surface.
--    SELECT is never named, so the read surface is untouched.
-- ============================================================================

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON ALL TABLES IN SCHEMA public
  FROM authenticated;

GRANT INSERT, UPDATE ON TABLE public.distribution_points TO authenticated;
GRANT INSERT, UPDATE ON TABLE public.organizations       TO authenticated;

-- ============================================================================
-- 3. MANUAL AVAILABILITY WRITER CLOSURE (H-24) — IDEMPOTENT REASSERTION
--
--    Migration 085 established this boundary and Production applied it; these
--    two statements REASSERT it rather than introduce it. On Production and on
--    a corrected replay both privileges are already absent, so both statements
--    are no-ops (REVOKE of an absent privilege is a documented Postgres
--    no-op). They are kept so 194 states the contracted end state in full
--    instead of depending on an earlier migration having run.
--
--    Bodies, owners, search_path and service_role access are all left exactly
--    as they are — only the `authenticated` client route is named.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.phoenix_upsert_availability(
  uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text
) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.phoenix_apply_availability_movement(
  uuid, text, integer, text, text
) FROM authenticated;

-- ============================================================================
-- 4. VERIFY — inside the transaction; any failure rolls back all of 194
-- ============================================================================

CREATE TEMP TABLE _m194_after_surface ON COMMIT DROP AS
  SELECT * FROM _m194_live_surface;

DROP VIEW _m194_live_surface;

DO $verify$
DECLARE
  v_bad        text;
  v_n          integer;
  -- The ONLY removals this migration is allowed to make.
  v_writers    text[] := ARRAY[
    'phoenix_upsert_availability(p_distribution_point_id uuid, p_scientific_name text, p_trade_name text, p_dosage_form text, p_concentration text, p_quantity integer, p_condition text, p_expiry_date date, p_batch_number text, p_notes text, p_supply_type text, p_price numeric, p_national_code text)',
    'phoenix_apply_availability_movement(p_item_availability_id uuid, p_movement_type text, p_amount integer, p_reason text, p_notes text)'
  ];
  v_expected   text[] := ARRAY[
    'distribution_points|INSERT',
    'distribution_points|UPDATE',
    'organizations|INSERT',
    'organizations|UPDATE'
  ];
  v_actual     text[];
BEGIN
  -- 4a. The authenticated direct-write surface is EXACTLY the contract.
  SELECT COALESCE(array_agg(x ORDER BY x), ARRAY[]::text[]) INTO v_actual
    FROM (
      SELECT c.relname || '|' || pr.p AS x
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN (SELECT unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS p) pr
       WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p','f')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d
                          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
         AND has_table_privilege('authenticated', c.oid, pr.p)
    ) s;
  IF v_actual <> v_expected THEN
    RAISE EXCEPTION 'M194 verify failed: authenticated direct-write surface is % (expected %)', v_actual, v_expected;
  END IF;

  -- 4b. Named sub-surfaces called out by the security contract. Subsumed by
  --     4a, asserted separately so a regression names itself in the failure.
  FOR v_bad IN
    SELECT c.relname || '|' || pr.p
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (SELECT unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS p) pr
     WHERE n.nspname = 'public'
       AND c.relname IN (
         -- RBAC / identity
         'profiles','permission_keys','role_permission_defaults',
         'profile_permission_overrides','profile_scope_assignments','user_identity_history',
         -- stock / custody chain
         'item_availability','item_availability_movements','warehouse_stock',
         'warehouse_stock_movements','outlet_stock','outlet_stock_movements',
         'warehouse_quarantine_stock','warehouse_quarantine_stock_movements',
         'warehouse_stock_in_transit',
         -- inter-organization alert / exchange lifecycle
         'inter_org_alert_events','inter_org_alert_states',
         'inter_org_exchange_events','inter_org_exchange_requests')
       AND has_table_privilege('authenticated', c.oid, pr.p)
     LIMIT 1
  LOOP
    RAISE EXCEPTION 'M194 verify failed: authenticated retains a forbidden direct write: %', v_bad;
  END LOOP;

  -- 4c. Sequences and anon relation/sequence surfaces stay empty.
  SELECT count(*) INTO v_n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (SELECT unnest(ARRAY['USAGE','SELECT','UPDATE']) AS p) pr
   WHERE n.nspname = 'public' AND c.relkind = 'S'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
     AND has_sequence_privilege('authenticated', c.oid, pr.p);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'M194 verify failed: authenticated holds % public sequence privileges (expected none)', v_n;
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS p) pr
   WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p','f')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
     AND has_table_privilege('anon', c.oid, pr.p);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'M194 verify failed: anon holds % public relation privileges (expected none)', v_n;
  END IF;

  -- 4d. The manual availability writers are closed to the client and to nobody
  --     else. service_role keeps EXECUTE; anon and PUBLIC never had it.
  IF has_function_privilege('authenticated',
       'public.phoenix_upsert_availability(uuid,text,text,text,text,integer,text,date,text,text,text,numeric,text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.phoenix_apply_availability_movement(uuid,text,integer,text,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'M194 verify failed: authenticated still holds EXECUTE on a manual availability writer';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.phoenix_upsert_availability(uuid,text,text,text,text,integer,text,date,text,text,text,numeric,text)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.phoenix_apply_availability_movement(uuid,text,integer,text,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'M194 verify failed: service_role lost EXECUTE on a manual availability writer';
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
   WHERE p.oid IN (
       'public.phoenix_upsert_availability(uuid,text,text,text,text,integer,text,date,text,text,text,numeric,text)'::regprocedure,
       'public.phoenix_apply_availability_movement(uuid,text,integer,text,text)'::regprocedure)
     AND a.grantee = 0;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'M194 verify failed: a manual availability writer is EXECUTE-able by PUBLIC';
  END IF;

  -- 4e. NOTHING ELSE MOVED. Exact before/after set comparison over the whole
  --     contracted surface. Every REMOVED tuple must be one this migration is
  --     allowed to remove (an `authenticated` non-SELECT relation privilege
  --     outside the contract, or `authenticated` EXECUTE on one of the two
  --     named writers). Nothing may be ADDED beyond the contracted grants.
  --     This is what proves the authenticated SELECT surface, the anon
  --     surfaces and every service_role privilege are untouched — measured on
  --     the live database, not asserted.
  SELECT string_agg(kind || '|' || rolname || '|' || object || '|' || privilege, '; ' ORDER BY 1)
    INTO v_bad
    FROM (
      SELECT * FROM _m194_before_surface
      EXCEPT
      SELECT * FROM _m194_after_surface
    ) removed
   WHERE NOT (
        (kind = 'RELATION' AND rolname = 'authenticated' AND privilege <> 'SELECT'
         AND NOT (object IN ('distribution_points','organizations') AND privilege IN ('INSERT','UPDATE')))
     OR (kind = 'FUNCTION' AND rolname = 'authenticated' AND object = ANY(v_writers))
   );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'M194 verify failed: this migration removed authorization it must not touch: %', v_bad;
  END IF;

  SELECT string_agg(kind || '|' || rolname || '|' || object || '|' || privilege, '; ' ORDER BY 1)
    INTO v_bad
    FROM (
      SELECT * FROM _m194_after_surface
      EXCEPT
      SELECT * FROM _m194_before_surface
    ) gained
   WHERE NOT (kind = 'RELATION' AND rolname = 'authenticated'
              AND object IN ('distribution_points','organizations')
              AND privilege IN ('INSERT','UPDATE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'M194 verify failed: this migration granted authorization it must not grant: %', v_bad;
  END IF;

  -- 4f. No function body, owner, search_path or SECURITY DEFINER flag moved,
  --     and no function was added or dropped.
  SELECT string_agg(ident, '; ' ORDER BY ident) INTO v_bad
    FROM (
      SELECT b.ident FROM _m194_before_functions b
      EXCEPT
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND md5(p.prosrc) = (SELECT body_md5 FROM _m194_before_functions f WHERE f.oid = p.oid)
         AND p.prosecdef  = (SELECT secdef   FROM _m194_before_functions f WHERE f.oid = p.oid)
         AND pg_get_userbyid(p.proowner) = (SELECT owner FROM _m194_before_functions f WHERE f.oid = p.oid)
         AND COALESCE(array_to_string(p.proconfig, ','), '')
             = (SELECT cfg FROM _m194_before_functions f WHERE f.oid = p.oid)
    ) moved;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'M194 verify failed: function definition changed (body/owner/search_path/security): %', v_bad;
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public';
  IF v_n <> (SELECT count(*) FROM _m194_before_functions) THEN
    RAISE EXCEPTION 'M194 verify failed: the function population changed';
  END IF;
END;
$verify$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. AUTHENTICATED_PUBLIC_WRITE_RELATIONS is exactly
--      { distribution_points:INSERT, distribution_points:UPDATE,
--        organizations:INSERT,       organizations:UPDATE }
--    — 2 relations, 4 tuples. Asserted in-transaction (4a) as an exact array
--    equality, not a count.
-- 2. AUTHENTICATED_PUBLIC_SEQUENCE_PRIVILEGES = {} (4c).
--    ANON_PUBLIC_RELATION_PRIVILEGES        = {} (4c).
--    ANON_PUBLIC_SEQUENCE_PRIVILEGES        = {} — anon holds no sequence
--    privilege because it holds none before or after; covered by the
--    no-additions proof (4e).
-- 3. AUTHENTICATED_STOCK_DIRECT_WRITES = {},
--    AUTHENTICATED_INTER_ORG_LIFECYCLE_DIRECT_WRITES = {},
--    AUTHENTICATED_RBAC_DIRECT_WRITES = {} (4b).
-- 4. Manual availability writer `authenticated` EXECUTE = NO; service_role
--    EXECUTE = YES; anon = NO; PUBLIC = none (4d).
-- 5. UNCHANGED, proven against a live before-image rather than asserted (4e,
--    4f): the authenticated SELECT surface, the anon surfaces, every
--    service_role relation/sequence/function privilege, every schema
--    privilege, and every function body, owner, search_path and SECURITY
--    DEFINER flag. RLS policies are not touched by any statement here.
-- 6. RECONCILIATION: this migration writes no data — pure privilege
--    convergence. Nothing to reconcile.
-- ============================================================================
-- ROLLBACK — privileges only, instant and lossless. There is no legitimate
-- reason to do this; it reopens H-24 and H-25:
--   GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
--     ON ALL TABLES IN SCHEMA public TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.phoenix_upsert_availability(
--     uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.phoenix_apply_availability_movement(
--     uuid, text, integer, text, text) TO authenticated;
-- ============================================================================
