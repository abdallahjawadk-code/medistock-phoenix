-- ===========================================================================
-- C6-F1 / M218 — CENTRAL NEEDS SUBMISSION INTEGRITY:
--               CAPABILITY-ISOLATED SEALED SUBMISSION (FINAL)
--
-- WHY THIS MIGRATION EXISTS
--   C6 certification (finding F1) proved that a privileged or BYPASSRLS table
--   writer could move a revision straight from DRAFT to SUBMITTED without the
--   canonical submit and its review-readiness gate, and that the canonical
--   approve then accepted it, because approve trusted the mere value
--   status = 'submitted'. Review then proved that lifecycle evidence kept in
--   audit_logs could be forged (R1-A), that nothing bound the approval to the
--   exact state readiness passed (R1-B), and that service_role — a BYPASSRLS
--   API caller holding platform-default DML, TRUNCATE and TRIGGER on every
--   application table and CREATE on schema public — could rewrite submitted
--   state directly, or attach a trigger whose function runs with the owner's
--   rights inside the owner-run RPCs (R2 and its disclosed residual). This
--   migration closes that capability CLASS instead of individual exploits.
--   M209-M217 files are immutable and untouched.
--
-- TRUST MODEL
--   Root of trust: a true superuser and the owner of the Central Needs tables
--   (the migration owner). NOT root: service_role, authenticated, anon, any
--   other BYPASSRLS or API role, application users. service_role is a
--   privileged API CALLER — not a DDL administrator, not a lifecycle-evidence
--   writer, not a Central Needs table writer. After this migration it reaches
--   Central Needs state only through the three SECURITY DEFINER functions the
--   trusted finalize-import endpoint calls (the payload digest, the
--   authoritative replay, the batch registration); it keeps SELECT. No
--   non-root role — directly, via PUBLIC or through inherited membership —
--   holds a Central Needs write, TRUNCATE, TRIGGER, REFERENCES or MAINTAIN
--   privilege, TRIGGER on any public relation, or CREATE on schema public or
--   phoenix_private.
--   READ VISIBILITY != MUTATION AUTHORITY (M218-HC1): the seal is a
--   mutation-capability seal. Effective read-only access — USAGE on a schema,
--   SELECT on a relation — authorizes no lifecycle transition and is not a
--   breach. A hosted platform read observer that inherits PostgreSQL's
--   predefined pg_read_all_data (USAGE on every schema, SELECT on every
--   relation) is therefore tolerated for what it can read; it is NOT root, and
--   any write, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN or CREATE privilege it
--   acquires on a guarded object is a breach like any other role's (an owner
--   is exempt on its own object; ownership of the Central Needs and private
--   objects is the migration owner's, VERIFY A). The capability test is by
--   privilege, never by role name, and counts inherited (effective)
--   privileges; a SET-only escalation path is certified by the role graph
--   (C6 N20).
--
-- THE INVARIANT (the authoritative chain)
--   UNTRUSTED CALLER -> EXPLICIT RPC CAPABILITY -> SECURITY-DEFINER BOUNDARY
--   -> DRAFT-ONLY DOMAIN MUTATION -> AUTHORITATIVE READINESS + ONE-TIME
--   SUBMISSION DIGEST (one statement, one snapshot) -> PRIVATE SUBMIT
--   ATTESTATION -> SEALED SUBMITTED STATE (no non-root write path) -> FRESH
--   APPROVAL-TIME ELIGIBILITY (M217 A2) -> PRIVATE APPROVE ATTESTATION ->
--   APPROVED -> FORENSIC AUDIT HISTORY.
--   AUDIT EVENT != AUTHORIZATION CAPABILITY: audit_logs records history
--   (submission_gate, submit, approval_gate, approve, supersede, reject,
--   correction) and authorizes nothing. The private attestation store is the
--   only lifecycle authority, and only the canonical submit and approve
--   write it.
--
-- THE SEAL — WHY APPROVE NO LONGER RE-HASHES THE CORPUS
--   The readiness-sensitive state of a revision (the digest scope, section 4)
--   can change only through
--     (a) a canonical RPC: every one loads the revision FOR UPDATE and refuses
--         unless it is DRAFT before its first write (VERIFY F proves the
--         writer census and that order);
--     (b) direct DML, TRUNCATE or a trigger: no non-root role holds the
--         privilege (VERIFY B/C; submit and approve re-check it on every call:
--         central_needs_capability_seal_breached);
--     (c) code injected into an owner-run transaction: no non-root role can
--         CREATE in public or phoenix_private or attach a trigger to any public
--         relation, and every SECURITY DEFINER search_path names only schemas
--         the root of trust alone can create in (VERIFY E);
--     (d) a foreign-key action: every business foreign key of a Central Needs
--         table is RESTRICT / NO ACTION; only auth.users actor stamps, outside
--         the digest, are SET NULL (VERIFY F).
--   Submit must run under READ COMMITTED
--   (central_needs_submit_requires_read_committed), so the snapshot of its
--   readiness-and-digest statement is taken after it holds the revision lock
--   every writer takes first. The digest attested at submit is therefore the
--   state that is approved: approve proves provenance (the SUBMIT attestation
--   bound to the revision's current row version), re-checks the seal and A2,
--   and carries the attested digest into the APPROVE attestation.
--
-- WHAT THIS MIGRATION ADDS OR CHANGES
--   1. Schema phoenix_private — owner: the migration owner; no privilege for
--      PUBLIC, anon, authenticated or service_role; not a Data API schema
--      (supabase/config.toml exposes public and graphql_public only):
--        central_needs_lifecycle_attestations — the private store: one row per
--          canonical SUBMIT or APPROVE (revision, owner organization, phase,
--          contract c6-f1-final-v1, actor, top-level txid, the submission
--          digest, the transaction timestamp); RLS on and FORCED, no policy;
--          RESTRICT foreign key to the revision;
--        central_needs_submission_state_digest_v1(uuid) — the R1 digest;
--        central_needs_submission_gate_fence_v1() — the submission fence;
--        central_needs_approval_gate_fence_v1(text, row, row) — the approval
--          fence body;
--        central_needs_capability_breaches_v1() — the seal predicate.
--      All SECURITY INVOKER (they run with the rights of the SECURITY DEFINER
--      RPC or trigger that calls them), search_path = pg_catalog, pg_temp,
--      every application object schema-qualified.
--   2. The trigger central_needs_plan_revisions_c6_submission_gate (BEFORE
--      UPDATE) on the private submission fence. M217's approval fence keeps
--      its public name, its trigger, SECURITY DEFINER and its
--      'public, pg_temp' search_path — the C5 activation contract pins all
--      four — and now only delegates to the private body with qualified names;
--      after this migration public is creatable by the root of trust alone.
--   3. submit and approve (same signatures): search_path = pg_catalog,
--      pg_temp. Submit adds the READ COMMITTED check, the seal predicate, the
--      private digest and store, and a FUNCTION-LEVEL statement_timeout
--      (PostgREST applies it to /rpc calls as a transaction-scoped setting; no
--      global or role timeout changes). Approve adds the seal predicate, drops
--      the approval-time re-hash and attests the sealed submission digest.
--   4. Capability convergence — the only ACL changes:
--        REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
--          on the 13 Central Needs tables FROM service_role (SELECT kept);
--        REVOKE TRIGGER on every public relation from every non-root grantee;
--        REVOKE CREATE ON SCHEMA public from every non-root grantee
--          (service_role, and phoenix_demo_purger, whose M141 grant served
--          only its one-time ownership transfer);
--        REVOKE EXECUTE on every Central Needs SECURITY DEFINER routine FROM
--          service_role, except the three it calls;
--        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRIGGER ON TABLES
--          FROM service_role — the one default changed: future tables of the
--          migration owner no longer grant it TRIGGER; the DML, sequence and
--          function EXECUTE defaults stay as they are.
--      authenticated and anon grants are untouched; VERIFY proves that every
--      other ACL entry and every other function body is byte-identical.
--   5. Readiness performance: one partial index,
--      central_needs_source_records_invalid_evidence_idx, serving M217's
--      legacy-evidence readiness blocker (section 12) — the readiness
--      predicate itself is unchanged.
--
-- ACTIVATION PRECONDITIONS AND LOCKS
--   PostgreSQL 17+ (MAINTAIN); READ COMMITTED; applied by the owner of the
--   Central Needs tables, which bypasses RLS and owns schema public directly
--   or through pg_database_owner; M217 present; refuses to run twice. The
--   whole transaction resolves names in pg_catalog, pg_temp only. LOCAL
--   lock_timeout = 250ms, statement_timeout = 60s; the 13 Central Needs tables
--   EXCLUSIVE NOWAIT, held to COMMIT (readers continue; an in-flight writer
--   fails M218 closed), plus the SHARE lock of the one CREATE INDEX on
--   source_records under it (the build classifies each existing record once);
--   VERIFY refuses while another session holds a DDL-class
--   lock on a public relation. ZERO submitted revisions: a revision submitted
--   before this migration has no attestation and none is ever synthesized,
--   backdated or inferred — resolve it through the governed reject first. No
--   business row is written.
--
-- OPERATIONAL NOTES (fail-closed by design)
--   * The SUBMIT attestation is bound to the revision's physical row version
--     (xmin) and to the updated_at its transition stamped. Any later rewrite
--     of a submitted revision row — a foreign-key SET NULL from a deleted auth
--     user, pg_repack, a LOGICAL dump/restore, a later migration that rewrites
--     plan_revisions — leaves it unapprovable; it is resolved through reject
--     and a new draft. Physical backups, PITR, pg_upgrade and VACUUM FREEZE
--     keep xmin.
--   * A restore with --no-privileges, or any later re-grant of a capability
--     listed above, makes every submit and approve refuse
--     central_needs_capability_seal_breached until the grants converge again.
--   * External eligibility (organizations, warehouses) is outside the seal and
--     is judged fresh by M217's A2 under FOR SHARE at approve time.
--   * A second canonical submit inside one transaction that already holds a
--     SUBMIT attestation for the revision fails closed on the store's
--     once_key (SQLSTATE 23505).
--   * Functions later created in phoenix_private receive EXECUTE for
--     service_role from the global function default. The explicit ACLs of
--     phoenix_private and its relations and routines are proven owner-only
--     when this migration applies (VERIFY D: schema ACL and object set; the
--     store check in B/C; VERIFY E: routine ACLs); after M218-HC1 the run-time
--     seal re-checks mutation capabilities only, not explicit read grants. A
--     hosted read observer (a member of pg_read_all_data) can resolve names
--     there, but pg_read_all_data confers no EXECUTE: every future routine in
--     phoenix_private must REVOKE ALL FROM PUBLIC, service_role itself. Such an
--     observer can also reference the store's row type and take ACCESS SHARE
--     locks, as on every relation — an availability exposure, not an integrity
--     one. Default privileges held by roles other than the migration owner
--     are outside this migration's authority and are not changed.
-- ===========================================================================

BEGIN;

-- Every unqualified name in this migration resolves in pg_catalog (and the
-- session's own temporary schema last): nothing in public can shadow it.
SET LOCAL search_path = pg_catalog, pg_temp;

-- ----------------------------------------------------------------------------
-- 0a. Transaction shape, applier, idempotence and dependencies — BEFORE any
--     relation lock. Catalog reads only.
-- ----------------------------------------------------------------------------
DO $prelude$
DECLARE
  f        text;
  v_me     oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user);
  v_super  boolean;
  v_bypass boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '218_requires_read_committed'
      USING DETAIL = format('transaction_isolation=%s', current_setting('transaction_isolation'));
  END IF;

  IF current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION '218_precondition_failed: PostgreSQL 17 or later is required (the MAINTAIN privilege)'
      USING DETAIL = format('server_version_num=%s', current_setting('server_version_num'));
  END IF;

  -- central_needs_plan_revisions is FORCE ROW LEVEL SECURITY with client-only
  -- policies: an applying role that does not bypass RLS would count zero
  -- submitted revisions and pass vacuously. Refuse it.
  SELECT r.rolsuper, r.rolbypassrls INTO v_super, v_bypass FROM pg_catalog.pg_roles r WHERE r.oid = v_me;
  IF NOT (v_super OR v_bypass) THEN
    RAISE EXCEPTION '218_precondition_failed: the applying role must bypass row-level security'
      USING DETAIL = format('role=%s', current_user);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'central_needs_plan_revisions_c6_submission_gate')
     OR to_regclass('phoenix_private.central_needs_lifecycle_attestations') IS NOT NULL
     OR to_regclass('public.central_needs_lifecycle_attestations') IS NOT NULL
     OR to_regprocedure('public._phoenix_central_needs_submission_state_digest_v1(uuid)') IS NOT NULL
     OR to_regprocedure('public._phoenix_central_needs_submission_gate_fence_v1()') IS NOT NULL THEN
    RAISE EXCEPTION '218_already_applied';
  END IF;
  -- The trusted schema is created here and nowhere else: one that already
  -- exists (whoever made it) is never adopted.
  IF to_regnamespace('phoenix_private') IS NOT NULL THEN
    RAISE EXCEPTION '218_precondition_failed: schema phoenix_private already exists'
      USING DETAIL = format('owner=%s', (SELECT pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'phoenix_private'));
  END IF;

  -- M218 completes the M217 approval gate; it is meaningless without it.
  IF to_regprocedure('public._phoenix_central_needs_approval_gate_fence_v1()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'central_needs_plan_revisions_c5_approval_gate'
                     AND tgrelid = to_regclass('public.central_needs_plan_revisions')) THEN
    RAISE EXCEPTION '218_precondition_failed: M217 (the approval gate) is not applied';
  END IF;

  FOREACH f IN ARRAY ARRAY[
    'central_needs_plans', 'central_needs_plan_revisions', 'audit_logs',
    'central_needs_source_files', 'central_needs_import_sessions', 'central_needs_source_records',
    'central_needs_record_mappings', 'central_needs_field_overrides', 'central_needs_import_batches',
    'central_needs_import_batch_entries', 'central_needs_beneficiary_column_mappings',
    'central_needs_beneficiary_regions', 'central_needs_need_lines', 'central_needs_need_line_sources'
  ] LOOP
    IF to_regclass('public.' || f) IS NULL THEN
      RAISE EXCEPTION '218_precondition_failed: table % is absent', f;
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public._phoenix_central_needs_guard_v1(uuid, text)',
    'public._phoenix_central_needs_assert_org_live_v1(uuid)',
    'public._phoenix_central_needs_load_revision_v1(uuid)',
    'public._phoenix_central_needs_assert_draft_v1(uuid, text)',
    'public._phoenix_central_needs_lock_plan_family_v1(uuid, integer)',
    'public._phoenix_central_needs_review_blockers_v1(uuid)',
    'public._phoenix_central_needs_payload_digest_v1(jsonb)',
    'public.phoenix_central_needs_apply_authoritative_replay(uuid, text, jsonb, jsonb)',
    'public.phoenix_central_needs_register_import_batch(uuid, text, text, text, text, jsonb, jsonb, bigint, integer, jsonb)',
    'public.phoenix_central_needs_submit_revision(uuid)',
    'public.phoenix_central_needs_approve_revision(uuid)',
    'public.phoenix_central_needs_reject_revision(uuid, text)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION '218_precondition_failed: % is absent', f;
    END IF;
  END LOOP;

  -- The root of trust applies M218: the owner of every Central Needs table
  -- (the schema, the store and the default-privilege change below all belong
  -- to it), able to act for schema public's owner (to revoke CREATE on it).
  IF EXISTS (SELECT 1
               FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.central_needs_plans'::regclass, 'public.central_needs_plan_revisions'::regclass, 'public.central_needs_source_files'::regclass, 'public.central_needs_import_sessions'::regclass, 'public.central_needs_source_records'::regclass, 'public.central_needs_record_mappings'::regclass, 'public.central_needs_field_overrides'::regclass, 'public.central_needs_import_batches'::regclass, 'public.central_needs_import_batch_entries'::regclass, 'public.central_needs_beneficiary_column_mappings'::regclass, 'public.central_needs_beneficiary_regions'::regclass, 'public.central_needs_need_lines'::regclass, 'public.central_needs_need_line_sources'::regclass)
                AND c.relowner <> v_me) THEN
    RAISE EXCEPTION '218_precondition_failed: M218 must be applied by the owner of the Central Needs tables'
      USING DETAIL = format('role=%s', current_user);
  END IF;
  IF NOT v_super
     AND NOT pg_has_role(v_me, (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'), 'MEMBER') THEN
    RAISE EXCEPTION '218_precondition_failed: the applying role must own schema public (directly or through pg_database_owner)'
      USING DETAIL = format('role=%s', current_user);
  END IF;

  -- Baselines VERIFY compares, never asserts: every ACL entry this migration
  -- does not deliberately revoke, and every function body it does not
  -- deliberately replace.
  PERFORM set_config('phoenix_m218.untouched_acl', (SELECT md5(coalesce(string_agg(t.x, ';' ORDER BY t.x COLLATE "C"), ''))
      FROM (
        SELECT format('R|%s|%s|%s|%s|%s', c.relname, c.relkind,
                      CASE WHEN a.grantee = 0 THEN '-' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable) AS x
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
         WHERE n.nspname = 'public'
           AND NOT (a.privilege_type = 'TRIGGER' AND a.grantee <> c.relowner AND (a.grantee = 0 OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.oid = a.grantee AND NOT x.rolsuper AND x.rolname !~ '^pg_' AND x.oid <> (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = current_database()))))
           AND NOT (a.grantee = 'service_role'::regrole
                    AND c.relname IN ('central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files', 'central_needs_import_sessions', 'central_needs_source_records', 'central_needs_record_mappings', 'central_needs_field_overrides', 'central_needs_import_batches', 'central_needs_import_batch_entries', 'central_needs_beneficiary_column_mappings', 'central_needs_beneficiary_regions', 'central_needs_need_lines', 'central_needs_need_line_sources')
                    AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'MAINTAIN'))
        UNION ALL
        SELECT format('C|%s.%s|%s|%s|%s', c.relname, att.attname,
                      CASE WHEN a.grantee = 0 THEN '-' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable)
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_catalog.pg_attribute att ON att.attrelid = c.oid AND att.attacl IS NOT NULL
         CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
         WHERE n.nspname = 'public'
        UNION ALL
        SELECT format('F|%s(%s)|%s|%s|%s', p.proname, pg_get_function_identity_arguments(p.oid),
                      CASE WHEN a.grantee = 0 THEN '-' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable)
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
         WHERE n.nspname = 'public'
           AND NOT (a.grantee = 'service_role'::regrole AND p.prosecdef
                    AND p.proname LIKE '%central\_needs\_%' AND p.proname NOT IN ('_phoenix_central_needs_payload_digest_v1', 'phoenix_central_needs_apply_authoritative_replay', 'phoenix_central_needs_register_import_batch'))
        UNION ALL
        SELECT format('N|%s|%s|%s', CASE WHEN a.grantee = 0 THEN '-' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable)
          FROM pg_catalog.pg_namespace n
         CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
         WHERE n.nspname = 'public'
           AND NOT (a.privilege_type = 'CREATE' AND a.grantee <> n.nspowner AND (a.grantee = 0 OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.oid = a.grantee AND NOT x.rolsuper AND x.rolname !~ '^pg_' AND x.oid <> (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = current_database()))))
        UNION ALL
        SELECT format('D|%s|%s|%s|%s|%s|%s', pg_get_userbyid(d.defaclrole), coalesce(dn.nspname, '-'), d.defaclobjtype,
                      CASE WHEN a.grantee = 0 THEN '-' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable)
          FROM pg_catalog.pg_default_acl d
          LEFT JOIN pg_catalog.pg_namespace dn ON dn.oid = d.defaclnamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
         WHERE a.grantee <> d.defaclrole
           AND NOT (d.defaclobjtype = 'r' AND dn.nspname = 'public'
                    AND a.grantee = 'service_role'::regrole AND a.privilege_type = 'TRIGGER')
      ) t), true);
  PERFORM set_config('phoenix_m218.untouched_functions', (SELECT md5(coalesce(string_agg(t.x, ';' ORDER BY t.x COLLATE "C"), ''))
      FROM (
        SELECT format('F|%s.%s(%s)|%s|%s|%s|%s|%s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
                      md5(p.prosrc), p.prosecdef, p.provolatile, pg_get_userbyid(p.proowner),
                      coalesce(array_to_string(p.proconfig, ','), '')) AS x
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('public', 'auth')
           AND NOT (n.nspname = 'public' AND p.proname IN ('phoenix_central_needs_submit_revision',
                                                           'phoenix_central_needs_approve_revision',
                                                           '_phoenix_central_needs_approval_gate_fence_v1'))
        UNION ALL
        SELECT format('T|%s.%s|%s|%s|%s|%s', n.nspname, c.relname, t.tgname, t.tgfoid::regprocedure, t.tgtype, t.tgenabled)
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('public', 'auth') AND NOT t.tgisinternal
           AND t.tgname <> 'central_needs_plan_revisions_c6_submission_gate'
      ) t), true);
END
$prelude$;

SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '60s';

-- ----------------------------------------------------------------------------
-- 0b. The activation lock, held to COMMIT: EXCLUSIVE on every Central Needs
--     table blocks every writer (and so every submit, direct DML and trigger
--     creation on them) while plain readers continue; NOWAIT makes an
--     in-flight writer fail M218 closed instead of queuing behind it — a
--     transaction already past a privilege check cannot commit a write, or a
--     trigger, after the revocations below.
-- ----------------------------------------------------------------------------
LOCK TABLE public.central_needs_plans,
           public.central_needs_plan_revisions,
           public.central_needs_source_files,
           public.central_needs_import_sessions,
           public.central_needs_source_records,
           public.central_needs_record_mappings,
           public.central_needs_field_overrides,
           public.central_needs_import_batches,
           public.central_needs_import_batch_entries,
           public.central_needs_beneficiary_column_mappings,
           public.central_needs_beneficiary_regions,
           public.central_needs_need_lines,
           public.central_needs_need_line_sources
  IN EXCLUSIVE MODE NOWAIT;

-- ----------------------------------------------------------------------------
-- 1. Activation data precondition — plain SELECTs under the lock. A revision
--    already SUBMITTED has no private attestation (none existed before M218)
--    and none may be synthesized: the migration fails closed and changes
--    nothing. The DETAIL classifies them for the operator only; a pre-M218
--    submit audit is attestation of history, never provenance.
-- ----------------------------------------------------------------------------
DO $precondition$
DECLARE
  v_submitted  bigint;
  v_attested   bigint;
BEGIN
  SELECT count(*) INTO v_submitted
    FROM public.central_needs_plan_revisions
   WHERE status = 'submitted';

  SELECT count(*) INTO v_attested
    FROM public.central_needs_plan_revisions r
   WHERE r.status = 'submitted'
     AND EXISTS (SELECT 1 FROM public.audit_logs a
                  WHERE a.action = 'central_needs.plan_revision.submit'
                    AND a.entity_type = 'central_needs_plan_revision'
                    AND a.entity_id = r.id
                    AND a.organization_id = r.organization_id
                    AND a.created_at = r.updated_at);

  IF v_submitted > 0 THEN
    RAISE EXCEPTION '218_precondition_failed'
      USING DETAIL = format('submitted=%s with_submit_audit=%s without_submit_audit=%s',
                            v_submitted, v_attested, v_submitted - v_attested),
            HINT = 'Resolve every submitted revision through the governed reject path (a separately authorized action) before applying M218; submission provenance is never synthesized, backdated or inferred.';
  END IF;

  -- Status fingerprint of every plan revision: VERIFY proves M218 changed none.
  PERFORM set_config('phoenix_m218.revision_status', (
    SELECT coalesce(md5(string_agg(id::text || ':' || status, ',' ORDER BY id)), 'empty')
      FROM public.central_needs_plan_revisions), true);
END
$precondition$;

-- ----------------------------------------------------------------------------
-- 2. The private trusted schema. Owned by the migration owner (the root of
--    trust); no privilege of any kind for PUBLIC, anon, authenticated or
--    service_role — not USAGE, not CREATE. It is not a Data API schema, and no
--    client policy stands in for this isolation. PRIVATE means private from
--    the application and the Data API: a hosted platform read observer that
--    inherits pg_read_all_data may still read it (M218-HC1), which authorizes
--    nothing — the seal (section 5) forbids every mutation capability.
-- ----------------------------------------------------------------------------
CREATE SCHEMA phoenix_private;
REVOKE ALL ON SCHEMA phoenix_private FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON SCHEMA phoenix_private IS
  'C6-F1 FINAL (218): trusted internal schema of the root of trust. No privilege for PUBLIC, anon, authenticated or service_role; never exposed through the Data API. Holds the Central Needs lifecycle attestation store and the security-only helpers.';

-- ----------------------------------------------------------------------------
-- 3. The private lifecycle attestation store. Only the canonical SECURITY
--    DEFINER submit and approve write it (as the owner). A row authorizes a
--    transition of exactly one revision of exactly one owner organization, only
--    inside the transaction (txid, transaction timestamp) that wrote it, only
--    for the actor that wrote it, only for its phase and contract version.
--    The RESTRICT foreign key means an attested revision cannot be deleted by
--    anyone who cannot delete its attestation.
-- ----------------------------------------------------------------------------
CREATE TABLE phoenix_private.central_needs_lifecycle_attestations (
  id               uuid        NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  plan_revision_id uuid        NOT NULL,
  organization_id  uuid        NOT NULL,
  phase            text        NOT NULL,
  contract         text        NOT NULL,
  actor_id         uuid        NOT NULL,
  txid             bigint      NOT NULL,
  state_digest     text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT central_needs_lifecycle_attestations_pkey PRIMARY KEY (id),
  CONSTRAINT central_needs_lifecycle_attestations_phase_chk CHECK (phase IN ('submit', 'approve')),
  CONSTRAINT central_needs_lifecycle_attestations_contract_chk CHECK (contract = 'c6-f1-final-v1'),
  CONSTRAINT central_needs_lifecycle_attestations_txid_chk CHECK (txid > 0),
  CONSTRAINT central_needs_lifecycle_attestations_digest_chk CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT central_needs_lifecycle_attestations_once_key UNIQUE (plan_revision_id, phase, txid),
  CONSTRAINT central_needs_lifecycle_attestations_revision_org_fk
    FOREIGN KEY (plan_revision_id, organization_id)
    REFERENCES public.central_needs_plan_revisions (id, organization_id) ON DELETE RESTRICT
);

REVOKE ALL ON TABLE phoenix_private.central_needs_lifecycle_attestations FROM PUBLIC, anon, authenticated, service_role;

-- Defence in depth behind the schema isolation: RLS on and FORCED, and no
-- policy at all, so a future accidental grant exposes no row to a reader
-- without BYPASSRLS. A BYPASSRLS read observer (a hosted role inheriting
-- pg_read_all_data, M218-HC1) does see the rows; reading an attestation
-- authorizes nothing (both fences require one written in the same
-- transaction by the canonical owner-run RPC).
ALTER TABLE phoenix_private.central_needs_lifecycle_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE phoenix_private.central_needs_lifecycle_attestations FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE phoenix_private.central_needs_lifecycle_attestations IS
  'C6-F1 FINAL (218): PRIVATE lifecycle attestation store — the only authority for DRAFT -> SUBMITTED and -> APPROVED. One row per canonical submit or approve: revision, owner organization, phase, contract c6-f1-final-v1, actor, top-level txid, the submission-state digest, the transaction timestamp. No privilege for PUBLIC, anon, authenticated or service_role; FORCE RLS without policies. audit_logs is forensic history only.';

-- ----------------------------------------------------------------------------
-- 4. The submission-state digest — computed ONCE, at the canonical submit.
--    SCOPE (derived from the latest readiness predicate and every helper it
--    calls; P = the revision):
--      revision identity  : id, plan_id, organization_id, revision_number
--                           (status is lifecycle, judged separately);
--      import sessions    : every session of P, whatever its status —
--                           id, source_file_id, status, preview/authoritative
--                           digests, parser_identity, entry_path;
--      source files       : id, file_hash of the files those sessions use;
--      source records     : every record of P's sessions, plus every record a
--                           need-line link of P points at — id, session,
--                           record_ordinal, target_entity, field_name,
--                           source_values, source_provenance;
--      record mappings    : of those records' sessions — id, session,
--                           target_entity, decision, central_item_id,
--                           decision_reason;
--      field overrides    : of P, plus every override of a linked record (the
--                           head is chosen across revisions by created_at DESC,
--                           id DESC) and every applied override — id,
--                           revision, record, target_entity, field_name,
--                           previous/final value, reason/note/reference, and
--                           created_at (ordering-bearing: UTC, microseconds,
--                           explicit era; infinities spelled out);
--      trusted batches    : of P — id, container_kind, container_sha256,
--                           accepted/excluded entry counts, reconciliation,
--                           parser_identity;
--      batch entries      : of those batches or P's sessions — id, batch,
--                           session, entry_ordinal, archive_entry_path,
--                           entry_sha256;
--      column mappings    : of P or its sessions — id, session, sheet, column,
--                           decision, beneficiary, source_field_name,
--                           mapping_reason;
--      region versions    : of P or its sessions (retired ones included) —
--                           version_id, region_id, version_no, supersedes,
--                           session, sheet, geometry, decision, beneficiary,
--                           decision_reason, retired (as a boolean),
--                           retirement_kind;
--      need lines         : of P — id, beneficiary, target warehouse, central
--                           item, approved_quantity, approved_unit,
--                           unit_conversion_state, source_unit_text,
--                           mapping_reason;
--      need-line links    : of P's lines, plus every link to P's records —
--                           id, need_line_id, source_record_id,
--                           designated_quantity, applied_override_id.
--    Deliberately excluded: actor stamps, creation/update timestamps that
--    carry no business meaning, organization_id of child rows (bound to P's
--    owner by composite foreign keys), storage metadata (locators, file names,
--    byte sizes), and external eligibility state: organizations and
--    warehouses, which M217's A2 judges fresh at approve time, and
--    central_items, which readiness does not read.
--    CANONICALIZATION: one jsonb_build_array per row with an explicit column
--    list (positional; SQL NULL -> JSON null, '' -> "", 0 -> 0, numeric keeps
--    its exact scale; every jsonb value enters as its canonical jsonb TEXT, so
--    a SQL NULL (null) and a JSON null ("null") stay distinct); rows aggregated
--    with jsonb_agg ORDER BY the row's uuid key (collation-free); every section
--    tagged by name; timestamps only as UTC text with microseconds and an
--    explicit era (AD/BC), +/-infinity as 'infinity'/'-infinity'; the whole
--    value's jsonb text encoded as UTF-8 and hashed with the built-in
--    sha256() — 64 lowercase hex characters. ONE statement, one snapshot;
--    STABLE, so it shares the snapshot of the statement that calls it. Every
--    multi-path scope is a UNION of index-driven subsets keyed by id.
-- ----------------------------------------------------------------------------
CREATE FUNCTION phoenix_private.central_needs_submission_state_digest_v1(p_plan_revision_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH
  rev AS (
    SELECT r.id, r.plan_id, r.organization_id, r.revision_number
      FROM public.central_needs_plan_revisions r
     WHERE r.id = p_plan_revision_id
  ),
  ses AS (
    SELECT s.id, s.source_file_id, s.status, s.preview_digest, s.authoritative_digest, s.parser_identity, s.entry_path
      FROM public.central_needs_import_sessions s
     WHERE s.plan_revision_id = p_plan_revision_id
  ),
  lin AS (
    SELECT n.id, n.beneficiary_organization_id, n.target_warehouse_id, n.central_item_id, n.approved_quantity,
           n.approved_unit, n.unit_conversion_state, n.source_unit_text, n.mapping_reason
      FROM public.central_needs_need_lines n
     WHERE n.plan_revision_id = p_plan_revision_id
  ),
  lnk AS (
    SELECT l.id, l.need_line_id, l.source_record_id, l.designated_quantity, l.applied_override_id
      FROM public.central_needs_need_line_sources l
     WHERE l.id IN (SELECT l1.id FROM public.central_needs_need_line_sources l1
                     WHERE l1.need_line_id IN (SELECT lin.id FROM lin)
                    UNION
                    SELECT l2.id FROM public.central_needs_need_line_sources l2
                     WHERE l2.source_record_id IN (SELECT sr.id FROM public.central_needs_source_records sr
                                                    WHERE sr.import_session_id IN (SELECT ses.id FROM ses)))
  ),
  rec AS (
    SELECT sr.id, sr.import_session_id, sr.record_ordinal, sr.target_entity, sr.field_name, sr.source_values, sr.source_provenance
      FROM public.central_needs_source_records sr
     WHERE sr.id IN (SELECT r1.id FROM public.central_needs_source_records r1
                      WHERE r1.import_session_id IN (SELECT ses.id FROM ses)
                     UNION
                     SELECT lnk.source_record_id FROM lnk)
  ),
  map AS (
    SELECT m.id, m.import_session_id, m.target_entity, m.decision, m.central_item_id, m.decision_reason
      FROM public.central_needs_record_mappings m
     WHERE m.import_session_id IN (SELECT rec.import_session_id FROM rec
                                   UNION
                                   SELECT ses.id FROM ses)
  ),
  ovr AS (
    SELECT o.id, o.plan_revision_id, o.source_record_id, o.target_entity, o.field_name, o.previous_value, o.final_value,
           o.override_reason, o.override_note, o.override_reference, o.created_at
      FROM public.central_needs_field_overrides o
     WHERE o.id IN (SELECT o1.id FROM public.central_needs_field_overrides o1
                     WHERE o1.plan_revision_id = p_plan_revision_id
                    UNION
                    SELECT o2.id FROM public.central_needs_field_overrides o2
                     WHERE o2.source_record_id IN (SELECT lnk.source_record_id FROM lnk)
                    UNION
                    SELECT lnk.applied_override_id FROM lnk WHERE lnk.applied_override_id IS NOT NULL)
  ),
  bat AS (
    SELECT b.id, b.container_kind, b.container_sha256, b.accepted_entry_count, b.excluded_entry_count,
           b.reconciliation, b.parser_identity
      FROM public.central_needs_import_batches b
     WHERE b.plan_revision_id = p_plan_revision_id
  ),
  ent AS (
    SELECT e.id, e.batch_id, e.import_session_id, e.entry_ordinal, e.archive_entry_path, e.entry_sha256
      FROM public.central_needs_import_batch_entries e
     WHERE e.id IN (SELECT e1.id FROM public.central_needs_import_batch_entries e1
                     WHERE e1.batch_id IN (SELECT bat.id FROM bat)
                    UNION
                    SELECT e2.id FROM public.central_needs_import_batch_entries e2
                     WHERE e2.import_session_id IN (SELECT ses.id FROM ses))
  ),
  col AS (
    SELECT c.id, c.import_session_id, c.sheet_index, c.column_index, c.decision, c.beneficiary_organization_id,
           c.source_field_name, c.mapping_reason
      FROM public.central_needs_beneficiary_column_mappings c
     WHERE c.id IN (SELECT c1.id FROM public.central_needs_beneficiary_column_mappings c1
                     WHERE c1.plan_revision_id = p_plan_revision_id
                    UNION
                    SELECT c2.id FROM public.central_needs_beneficiary_column_mappings c2
                     WHERE c2.import_session_id IN (SELECT ses.id FROM ses))
  ),
  reg AS (
    SELECT g.version_id, g.region_id, g.version_no, g.supersedes_version_id, g.import_session_id, g.sheet_index,
           g.row_start, g.row_end, g.column_start, g.column_end, g.decision, g.beneficiary_organization_id,
           g.decision_reason, g.retired_at, g.retirement_kind
      FROM public.central_needs_beneficiary_regions g
     WHERE g.version_id IN (SELECT g1.version_id FROM public.central_needs_beneficiary_regions g1
                             WHERE g1.plan_revision_id = p_plan_revision_id
                            UNION
                            SELECT g2.version_id FROM public.central_needs_beneficiary_regions g2
                             WHERE g2.import_session_id IN (SELECT ses.id FROM ses))
  ),
  fil AS (
    SELECT f.id, f.file_hash
      FROM public.central_needs_source_files f
     WHERE f.id IN (SELECT ses.source_file_id FROM ses)
  )
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(jsonb_build_array(
    'c6-f1-r1-state-v1',
    jsonb_build_array('revision', (SELECT jsonb_build_array(rev.id, rev.plan_id, rev.organization_id, rev.revision_number) FROM rev)),
    jsonb_build_array('sessions', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        ses.id, ses.source_file_id, ses.status, ses.preview_digest, ses.authoritative_digest, ses.parser_identity::text, ses.entry_path)
        ORDER BY ses.id), '[]'::jsonb) FROM ses)),
    jsonb_build_array('files', (SELECT COALESCE(jsonb_agg(jsonb_build_array(fil.id, fil.file_hash) ORDER BY fil.id), '[]'::jsonb) FROM fil)),
    jsonb_build_array('records', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        rec.id, rec.import_session_id, rec.record_ordinal, rec.target_entity, rec.field_name, rec.source_values::text, rec.source_provenance::text)
        ORDER BY rec.id), '[]'::jsonb) FROM rec)),
    jsonb_build_array('mappings', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        map.id, map.import_session_id, map.target_entity, map.decision, map.central_item_id, map.decision_reason)
        ORDER BY map.id), '[]'::jsonb) FROM map)),
    jsonb_build_array('overrides', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        ovr.id, ovr.plan_revision_id, ovr.source_record_id, ovr.target_entity, ovr.field_name, ovr.previous_value::text, ovr.final_value::text,
        ovr.override_reason, ovr.override_note, ovr.override_reference,
        CASE WHEN isfinite(ovr.created_at)
             THEN to_char(ovr.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US BC')
             ELSE ovr.created_at::text END)
        ORDER BY ovr.id), '[]'::jsonb) FROM ovr)),
    jsonb_build_array('batches', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        bat.id, bat.container_kind, bat.container_sha256, bat.accepted_entry_count, bat.excluded_entry_count,
        bat.reconciliation::text, bat.parser_identity::text)
        ORDER BY bat.id), '[]'::jsonb) FROM bat)),
    jsonb_build_array('entries', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        ent.id, ent.batch_id, ent.import_session_id, ent.entry_ordinal, ent.archive_entry_path, ent.entry_sha256)
        ORDER BY ent.id), '[]'::jsonb) FROM ent)),
    jsonb_build_array('columns', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        col.id, col.import_session_id, col.sheet_index, col.column_index, col.decision, col.beneficiary_organization_id,
        col.source_field_name, col.mapping_reason)
        ORDER BY col.id), '[]'::jsonb) FROM col)),
    jsonb_build_array('regions', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        reg.version_id, reg.region_id, reg.version_no, reg.supersedes_version_id, reg.import_session_id, reg.sheet_index,
        reg.row_start, reg.row_end, reg.column_start, reg.column_end, reg.decision, reg.beneficiary_organization_id,
        reg.decision_reason, reg.retired_at IS NOT NULL, reg.retirement_kind)
        ORDER BY reg.version_id), '[]'::jsonb) FROM reg)),
    jsonb_build_array('need_lines', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        lin.id, lin.beneficiary_organization_id, lin.target_warehouse_id, lin.central_item_id, lin.approved_quantity,
        lin.approved_unit, lin.unit_conversion_state, lin.source_unit_text, lin.mapping_reason)
        ORDER BY lin.id), '[]'::jsonb) FROM lin)),
    jsonb_build_array('links', (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        lnk.id, lnk.need_line_id, lnk.source_record_id, lnk.designated_quantity, lnk.applied_override_id)
        ORDER BY lnk.id), '[]'::jsonb) FROM lnk))
  )::text, 'UTF8')), 'hex')
$$;

REVOKE ALL ON FUNCTION phoenix_private.central_needs_submission_state_digest_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION phoenix_private.central_needs_submission_state_digest_v1(uuid) IS
  'C6-F1 FINAL (218) internal: deterministic SHA-256 of the readiness-sensitive, revision-owned state of one plan revision (sessions, files, records, mappings, overrides, batches, entries, column mappings, region versions, need lines, links; explicit positional rows, uuid order, UTC timestamps with era). STABLE: computed once, by the canonical submit, in the same statement (snapshot) as readiness, and written into the private SUBMIT attestation. Not reachable by any non-root role.';

-- ----------------------------------------------------------------------------
-- 5. The seal predicate — a MUTATION-capability seal. One row per non-root
--    capability that could change a submitted revision's state or inject code
--    into an owner-run lifecycle transaction. Non-root: every role that is not
--    a true superuser, not the database owner and not a predefined pg_* role
--    (a member of one is enumerated itself); an object's owner is exempt on
--    its own object. Effective privileges (has_*_privilege) cover direct
--    grants, PUBLIC and inherited membership (a membership usable only
--    through SET ROLE is certified by the role graph, C6 N20). Read
--    visibility (USAGE, SELECT) is not a capability (M218-HC1): a member of
--    pg_read_all_data is reported only for what it can change, like every
--    other role. VERIFY requires it empty; submit and approve refuse while it
--    is not (central_needs_capability_seal_breached).
-- ----------------------------------------------------------------------------
CREATE FUNCTION phoenix_private.central_needs_capability_breaches_v1()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH
  nonroot AS (
    SELECT r.oid, r.rolname
      FROM pg_catalog.pg_roles r
     WHERE NOT r.rolsuper
       AND r.rolname !~ '^pg_'
       AND r.oid <> (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
  ),
  guarded_schema AS (
    SELECT n.oid, n.nspname, n.nspowner
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname IN ('public', 'phoenix_private')
  ),
  cn AS (
    SELECT c.oid, c.relowner, n.nspname, c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE (n.nspname = 'public' AND c.relname IN ('central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files', 'central_needs_import_sessions', 'central_needs_source_records', 'central_needs_record_mappings', 'central_needs_field_overrides', 'central_needs_import_batches', 'central_needs_import_batch_entries', 'central_needs_beneficiary_column_mappings', 'central_needs_beneficiary_regions', 'central_needs_need_lines', 'central_needs_need_line_sources'))
        OR (n.nspname = 'phoenix_private' AND c.relname = 'central_needs_lifecycle_attestations')
  )
  -- (a) no non-root write, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any
  --     Central Needs relation or on the private store
  SELECT pg_catalog.format('%s holds %s on %I.%I', u.rolname, p.priv, cn.nspname, cn.relname)
    FROM nonroot u
   CROSS JOIN cn
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) AS p(priv)
   WHERE u.oid <> cn.relowner
     AND pg_catalog.has_table_privilege(u.oid, cn.oid, p.priv)
  UNION ALL
  SELECT pg_catalog.format('%s holds a column-level %s on %I.%I', u.rolname, p.priv, cn.nspname, cn.relname)
    FROM nonroot u
   CROSS JOIN cn
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(priv)
   WHERE u.oid <> cn.relowner
     AND NOT pg_catalog.has_table_privilege(u.oid, cn.oid, p.priv)
     AND pg_catalog.has_any_column_privilege(u.oid, cn.oid, p.priv)
  UNION ALL
  -- (b) no non-root TRIGGER on any relation of the application schema: a
  --     trigger fires inside every owner-run transaction that writes it
  SELECT pg_catalog.format('%s holds TRIGGER on public.%I', u.rolname, c.relname)
    FROM nonroot u
   CROSS JOIN pg_catalog.pg_class c
    JOIN guarded_schema s ON s.oid = c.relnamespace AND s.nspname = 'public'
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND u.oid <> c.relowner
     AND pg_catalog.has_table_privilege(u.oid, c.oid, 'TRIGGER')
  UNION ALL
  -- (c) no non-root CREATE on public or the private schema: a new object there
  --     is code or state an owner-run transaction could resolve. USAGE alone
  --     only looks names up (M218-HC1: pg_read_all_data holds it on every
  --     schema), so it is not a breach; the private relations and routines
  --     keep owner-only ACLs, proven when M218 applies (VERIFY B/C, D, E).
  SELECT pg_catalog.format('%s holds %s on schema %I', u.rolname, p.priv, s.nspname)
    FROM nonroot u
   CROSS JOIN guarded_schema s
   CROSS JOIN (VALUES ('CREATE')) AS p(priv)
   WHERE u.oid <> s.nspowner
     AND pg_catalog.has_schema_privilege(u.oid, s.oid, p.priv)
  UNION ALL
  -- (d) no object in public or the private schema owned by an API role
  --     (what a CREATE granted to one of them could have left behind)
  SELECT pg_catalog.format('%s owns %s %I.%I', r.rolname, o.kind, s.nspname, o.name)
    FROM (SELECT c.relowner AS owner, 'relation' AS kind, c.relname::text AS name, c.relnamespace AS ns FROM pg_catalog.pg_class c
          UNION ALL
          SELECT p.proowner, 'routine', p.proname::text, p.pronamespace FROM pg_catalog.pg_proc p
          UNION ALL
          SELECT t.typowner, 'type', t.typname::text, t.typnamespace FROM pg_catalog.pg_type t
          UNION ALL
          SELECT o.oprowner, 'operator', o.oprname::text, o.oprnamespace FROM pg_catalog.pg_operator o) AS o
    JOIN guarded_schema s ON s.oid = o.ns
    JOIN pg_catalog.pg_roles r ON r.oid = o.owner
   WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
$$;

REVOKE ALL ON FUNCTION phoenix_private.central_needs_capability_breaches_v1() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION phoenix_private.central_needs_capability_breaches_v1() IS
  'C6-F1 FINAL (218, HC1) internal: the mutation-capability seal. Lists every non-root capability (effective: direct, PUBLIC or inherited) that could change a submitted Central Needs revision or inject code into an owner-run lifecycle transaction: Central Needs or private-store write/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN (table or column level), TRIGGER on any public relation, CREATE on public or phoenix_private, objects in those schemas owned by anon/authenticated/service_role. Read visibility (USAGE, SELECT — e.g. a hosted observer inheriting pg_read_all_data) authorizes nothing and is not listed. Empty after M218 (VERIFY); submit and approve refuse while it is not.';

-- ----------------------------------------------------------------------------
-- 6. The submission fence. A revision may move from DRAFT to SUBMITTED only in
--    a transaction that already wrote the PRIVATE SUBMIT attestation for it:
--    same revision and owner, phase submit, contract c6-f1-final-v1, actor =
--    auth.uid(), txid = this transaction, created_at =
--    transaction_timestamp(). Only the canonical submit writes it, after
--    readiness PASSED, while holding the revision lock every writer takes
--    first; the digest in it was taken in readiness's snapshot and is not
--    recomputed here. An audit row of any shape never satisfies it. The fence
--    judges exactly that one transition; every other write passes untouched.
-- ----------------------------------------------------------------------------
CREATE FUNCTION phoenix_private.central_needs_submission_gate_fence_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'submitted' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM phoenix_private.central_needs_lifecycle_attestations a
       WHERE a.plan_revision_id = NEW.id
         AND a.organization_id  = NEW.organization_id
         AND a.phase            = 'submit'
         AND a.contract         = 'c6-f1-final-v1'
         AND a.actor_id         = auth.uid()
         AND a.txid             = txid_current()
         AND a.created_at       = transaction_timestamp()
    ) THEN
      RAISE EXCEPTION 'central_needs_submission_gate_missing' USING ERRCODE = '23514',
        DETAIL = format('revision=%s', NEW.id),
        HINT = 'A revision becomes submitted only through phoenix_central_needs_submit_revision.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION phoenix_private.central_needs_submission_gate_fence_v1() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION phoenix_private.central_needs_submission_gate_fence_v1() IS
  'C6-F1 FINAL (218) internal: the submission fence. BEFORE UPDATE on central_needs_plan_revisions, DRAFT -> SUBMITTED requires the private same-transaction SUBMIT attestation (central_needs_submission_gate_missing otherwise); an audit_logs row never satisfies it. Not reachable by any non-root role.';

-- ----------------------------------------------------------------------------
-- 7. The approval fence. The body is private; M217's public trigger function
--    keeps its name, trigger, SECURITY DEFINER and search_path (pinned by the
--    C5 activation contract) and only delegates, with qualified names. A
--    revision may BECOME approved — by INSERT or by UPDATE from any other
--    status — only in a transaction that already wrote the PRIVATE APPROVE
--    attestation for it (same revision and owner, phase approve, contract
--    c6-f1-final-v1, actor = auth.uid(), txid = this transaction, created_at =
--    transaction_timestamp()). Only the canonical approve writes it, after
--    provenance, the seal predicate and A2 pass. The M217 approval-gate audit
--    row is still written for history and authorizes nothing.
-- ----------------------------------------------------------------------------
CREATE FUNCTION phoenix_private.central_needs_approval_gate_fence_v1(
  p_op  text,
  p_old public.central_needs_plan_revisions,
  p_new public.central_needs_plan_revisions
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_new.status = 'approved'
     AND (p_op = 'INSERT' OR p_old.status IS DISTINCT FROM 'approved') THEN
    IF NOT EXISTS (
      SELECT 1
        FROM phoenix_private.central_needs_lifecycle_attestations a
       WHERE a.plan_revision_id = p_new.id
         AND a.organization_id  = p_new.organization_id
         AND a.phase            = 'approve'
         AND a.contract         = 'c6-f1-final-v1'
         AND a.actor_id         = auth.uid()
         AND a.txid             = txid_current()
         AND a.created_at       = transaction_timestamp()
    ) THEN
      RAISE EXCEPTION 'central_needs_approval_gate_missing' USING ERRCODE = '23514',
        DETAIL = format('revision=%s', p_new.id),
        HINT = 'A revision becomes approved only through phoenix_central_needs_approve_revision.';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION phoenix_private.central_needs_approval_gate_fence_v1(text, public.central_needs_plan_revisions, public.central_needs_plan_revisions) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION phoenix_private.central_needs_approval_gate_fence_v1(text, public.central_needs_plan_revisions, public.central_needs_plan_revisions) IS
  'C6-F1 FINAL (218) internal: the approval fence body. A row becoming approved requires the private same-transaction APPROVE attestation (central_needs_approval_gate_missing otherwise); an audit_logs row never satisfies it. Called only by the M217 trigger function public._phoenix_central_needs_approval_gate_fence_v1. Not reachable by any non-root role.';

CREATE OR REPLACE FUNCTION public._phoenix_central_needs_approval_gate_fence_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM phoenix_private.central_needs_approval_gate_fence_v1(TG_OP, OLD, NEW);
  RETURN NEW;
END;
$$;

-- CREATE OR REPLACE keeps this function's privileges (no client EXECUTE, per
-- M217); nothing here grants or revokes.

COMMENT ON FUNCTION public._phoenix_central_needs_approval_gate_fence_v1() IS
  'C5 (217), C6-F1 FINAL (218) internal: the approval fence trigger function (BEFORE INSERT OR UPDATE on central_needs_plan_revisions). Name, trigger, SECURITY DEFINER and search_path are pinned by the C5 activation contract; the judgement is the private phoenix_private.central_needs_approval_gate_fence_v1 (a same-transaction APPROVE attestation, never an audit row). Not client-callable.';

-- ----------------------------------------------------------------------------
-- 8. Replacement of phoenix_central_needs_submit_revision (same signature;
--    CREATE OR REPLACE keeps its ACL, which section 11 then narrows). The
--    M211 body — load (revision FOR UPDATE), guard, draft assertion, server
--    readiness and refusal mapping, counts, audit, return — hardened:
--    search_path = pg_catalog, pg_temp with every application object
--    qualified; READ COMMITTED required first; the seal predicate before
--    readiness; readiness and the private digest in ONE statement (one
--    snapshot; it always yields one row, so "ready" is a NULL blocker); after
--    readiness PASSED, that digest in the private SUBMIT attestation; the
--    forensic submission-gate audit; the transition; the submit audit with
--    submission_gate_txid, revision_xmin and submission_state_digest.
--    statement_timeout 30s is FUNCTION-LEVEL: PostgREST applies a
--    function's statement_timeout to its /rpc call as a transaction-scoped
--    setting (db-hoisted-tx-settings); no global or role timeout changes.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_submit_revision(
  p_plan_revision_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_revision   public.central_needs_plan_revisions%ROWTYPE;
  v_blocker    record;
  v_completed  bigint;
  v_batches    bigint;
  -- 218 (C6-F1)
  v_state_digest text;
  v_breach       text;
BEGIN
  -- 218 (C6-F1 FINAL) — the seal rests on READ COMMITTED: the snapshot of the
  -- readiness-and-digest statement below must be taken after this transaction
  -- holds the revision lock every writer takes first, not at transaction
  -- start. Refused before any lock or read.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'central_needs_submit_requires_read_committed' USING ERRCODE = '0A000',
      DETAIL = format('transaction_isolation=%s', current_setting('transaction_isolation')),
      HINT = 'Submit the revision in a READ COMMITTED transaction (the default).';
  END IF;

  v_revision   := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);
  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.edit');
  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_revision.status);

  -- 218 (C6-F1 FINAL) — the seal predicate: no non-root role may hold a
  -- capability that could change the state attested below after this submit.
  SELECT x.breach INTO v_breach
    FROM phoenix_private.central_needs_capability_breaches_v1() AS x(breach)
   ORDER BY x.breach
   LIMIT 1;
  IF v_breach IS NOT NULL THEN
    RAISE EXCEPTION 'central_needs_capability_seal_breached' USING ERRCODE = '55000',
      DETAIL = v_breach,
      HINT = 'A non-root role holds a capability M218 revokes. Converge the grants (a root-of-trust action) before submitting.';
  END IF;

  -- 218 (C6-F1) — readiness and the submission-state digest in ONE statement,
  -- hence ONE snapshot (both are STABLE): the digest attested below is exactly
  -- the state this readiness judgement passed. The statement always yields
  -- one row; the blocker columns are NULL when the revision is ready.
  SELECT b.blocker, b.detail, d.state_digest INTO v_blocker
    FROM (SELECT phoenix_private.central_needs_submission_state_digest_v1(p_plan_revision_id) AS state_digest) d
    LEFT JOIN LATERAL (SELECT x.blocker, x.detail
                         FROM public._phoenix_central_needs_review_blockers_v1(p_plan_revision_id) x
                        LIMIT 1) b ON true;

  IF v_blocker.blocker IS NOT NULL THEN
    IF v_blocker.blocker = 'no_finalized_import' THEN
      RAISE EXCEPTION 'plan_revision_has_no_finalized_import' USING ERRCODE = '23514',
        HINT = 'Finalize an import with an authoritative Node replay before submitting the revision for review.';
    ELSIF v_blocker.blocker = 'import_session_still_open' THEN
      RAISE EXCEPTION 'plan_revision_has_open_import_session' USING ERRCODE = '23514',
        DETAIL = v_blocker.detail,
        HINT = 'Finish or abandon every pending/processing import attempt before submitting.';
    ELSIF v_blocker.blocker = 'completed_session_not_in_trusted_batch' THEN
      RAISE EXCEPTION 'plan_revision_has_unbatched_completed_import' USING ERRCODE = '23514',
        DETAIL = v_blocker.detail,
        HINT = 'A finalized import that no trusted batch claims may be a partially replayed archive. It cannot be submitted.';
    ELSIF v_blocker.blocker = 'incomplete_trusted_batch' THEN
      RAISE EXCEPTION 'plan_revision_has_incomplete_import_batch' USING ERRCODE = '23514',
        DETAIL = v_blocker.detail;
    ELSIF v_blocker.blocker = 'target_entity_without_disposition' THEN
      RAISE EXCEPTION 'plan_revision_has_undecided_target_entity' USING ERRCODE = '23514',
        DETAIL = v_blocker.detail,
        HINT = 'Every imported row needs an explicit decision: map it to a central item, or mark it not applicable with a reason.';
    ELSE
      RAISE EXCEPTION 'plan_revision_not_ready_for_review' USING ERRCODE = '23514',
        DETAIL = format('blocker=%s %s', v_blocker.blocker, COALESCE(v_blocker.detail, ''));
    END IF;
  END IF;

  SELECT count(*) INTO v_completed
    FROM public.central_needs_import_sessions
   WHERE plan_revision_id = p_plan_revision_id AND status = 'completed';
  SELECT count(*) INTO v_batches
    FROM public.central_needs_import_batches
   WHERE plan_revision_id = p_plan_revision_id;

  -- 218 (C6-F1) — readiness PASSED: the digest taken in that same snapshot
  -- goes into the PRIVATE SUBMIT attestation, the only authority the
  -- submission fence accepts. Computed once, server-side; no caller input
  -- reaches it.
  v_state_digest := v_blocker.state_digest;

  INSERT INTO phoenix_private.central_needs_lifecycle_attestations (
    plan_revision_id, organization_id, phase, contract, actor_id, txid, state_digest
  ) VALUES (
    p_plan_revision_id, v_revision.organization_id, 'submit', 'c6-f1-final-v1', v_actor, txid_current(), v_state_digest
  );

  -- 218 (C6-F1) — the submission-gate audit event: forensic history only.
  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.submission_gate', 'central_needs_plan_revision', p_plan_revision_id,
    format('revision %s', v_revision.revision_number),
    jsonb_build_object(
      'contract', 'c6-f1-v1',
      'txid', txid_current()::text,
      'plan_id', v_revision.plan_id,
      'revision_number', v_revision.revision_number
    )
  );

  UPDATE public.central_needs_plan_revisions
     SET status = 'submitted'
   WHERE id = p_plan_revision_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.submit', 'central_needs_plan_revision', p_plan_revision_id,
    format('revision %s', v_revision.revision_number),
    jsonb_build_object(
      'plan_id', v_revision.plan_id,
      'revision_number', v_revision.revision_number,
      'from_status', 'draft', 'to_status', 'submitted',
      'finalized_import_count', v_completed,
      'registered_batch_count', v_batches,
      -- 218 (C6-F1): correlates this submit with its same-transaction gate,
      -- the row version the transition above wrote, and the attested digest.
      'submission_gate_txid', txid_current()::text,
      'revision_xmin', (SELECT r.xmin::text FROM public.central_needs_plan_revisions r WHERE r.id = p_plan_revision_id),
      'submission_state_digest', v_state_digest
    )
  );

  RETURN jsonb_build_object('ok', true, 'plan_revision_id', p_plan_revision_id, 'status', 'submitted');
END;
$$;

COMMENT ON FUNCTION public.phoenix_central_needs_submit_revision(uuid) IS
  'CN-2B (211, C6-F1 FINAL 218): submits a draft revision for review. READ COMMITTED only (central_needs_submit_requires_read_committed); the seal predicate (central_needs_capability_seal_breached); then the single server readiness predicate and the submission-state digest in ONE statement (one snapshot); refuses unless every completeness precondition holds, then records that digest in the PRIVATE same-transaction SUBMIT attestation (the only authority the submission fence accepts), writes the forensic submission-gate audit, the DRAFT -> SUBMITTED transition and the submit audit (submission_gate_txid, revision_xmin, submission_state_digest). Function-level statement_timeout for /rpc callers.';

-- ----------------------------------------------------------------------------
-- 9. Replacement of phoenix_central_needs_approve_revision (same signature;
--    CREATE OR REPLACE keeps its ACL, which section 11 then narrows). The
--    M217 body verbatim — guard order, idempotent replay, lifecycle A-E, A2
--    and its lock order, the approval-gate audit, the switch and its audits —
--    hardened: search_path = pg_catalog, pg_temp; after lifecycle A-D, the
--    PRIVATE SUBMIT attestation bound to the CURRENT row version (the
--    attestation and the transition were written by one subtransaction, so
--    their xmin agree, and its created_at is the updated_at that transition
--    stamped) and the seal predicate; NO re-hash of the submitted state (the
--    seal makes it the attested state); after A2, the PRIVATE APPROVE
--    attestation carrying the sealed submission digest. The mere value
--    status = 'submitted' — or any audit row — is never proof.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_approve_revision(
  p_plan_revision_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_revision    public.central_needs_plan_revisions%ROWTYPE;
  v_plan        public.central_needs_plans%ROWTYPE;
  v_latest      public.central_needs_plan_revisions%ROWTYPE;
  v_predecessor public.central_needs_plan_revisions%ROWTYPE;
  v_approved    integer;
  v_rows        integer;
  -- 217 (C5 §3/§4)
  v_line        record;
  v_ben         record;
  v_wh          record;
  v_reason      text;
  v_blocker     text;
  -- 218 (C6-F1)
  v_submitted_digest text;
  v_breach           text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_revision_id IS NULL THEN
    RAISE EXCEPTION 'plan_revision_id_required' USING ERRCODE = '23514';
  END IF;

  -- Unlocked resolution: only the organization is needed to authorize, and the
  -- family lock below is always taken in the same order by every writer.
  SELECT * INTO v_revision
    FROM public.central_needs_plan_revisions
   WHERE id = p_plan_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.approve');

  -- 217 (C5 §3) — the plan owner organization FOR SHARE, and live, BEFORE the
  -- family lock: the one order every approver takes.
  PERFORM 1 FROM public.organizations WHERE id = v_revision.organization_id FOR SHARE;
  PERFORM public._phoenix_central_needs_assert_org_live_v1(v_revision.organization_id);

  SELECT * INTO v_plan FROM public.central_needs_plans WHERE id = v_revision.plan_id;
  v_plan := public._phoenix_central_needs_lock_plan_family_v1(v_plan.organization_id, v_plan.plan_year);

  -- Re-read under the lock: this is the state the decision is made on.
  SELECT * INTO v_revision
    FROM public.central_needs_plan_revisions
   WHERE id = p_plan_revision_id;

  IF v_revision.status = 'approved' THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'plan_revision_id', p_plan_revision_id, 'status', 'approved'
    );
  END IF;

  IF v_revision.status <> 'submitted' THEN
    RAISE EXCEPTION 'plan_revision_not_submitted' USING ERRCODE = '23514',
      DETAIL = format('revision=%s status=%s', p_plan_revision_id, v_revision.status),
      HINT = 'Only a submitted revision can be approved.';
  END IF;

  SELECT * INTO v_latest
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id
   ORDER BY revision_number DESC
   LIMIT 1;
  IF v_latest.id <> v_revision.id THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('submitted revision=%s (revision %s) is not the newest revision of plan=%s (newest %s)',
                      v_revision.id, v_revision.revision_number, v_plan.id, v_latest.revision_number);
  END IF;

  SELECT count(*) INTO v_approved
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id AND status = 'approved';
  IF v_approved > 1 THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('plan=%s holds %s approved revisions', v_plan.id, v_approved);
  END IF;

  -- 218 (C6-F1) — canonical submission provenance: the PRIVATE SUBMIT
  -- attestation of this revision and owner whose row version (xmin) is the
  -- revision row's CURRENT xmin and whose created_at is the updated_at the
  -- canonical transition stamped. A revision made SUBMITTED any other way,
  -- re-created, moved back from rejected, or touched after its canonical
  -- submit, has none; nothing is repaired.
  SELECT a.state_digest INTO v_submitted_digest
    FROM phoenix_private.central_needs_lifecycle_attestations a
    JOIN public.central_needs_plan_revisions r ON r.id = a.plan_revision_id
   WHERE a.plan_revision_id = v_revision.id
     AND a.organization_id  = v_revision.organization_id
     AND a.phase            = 'submit'
     AND a.contract         = 'c6-f1-final-v1'
     AND a.xmin             = r.xmin
     AND a.created_at       = v_revision.updated_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'central_needs_submission_provenance_missing' USING ERRCODE = '23514',
      DETAIL = format('revision=%s', p_plan_revision_id),
      HINT = 'A revision is approvable only in the submitted state phoenix_central_needs_submit_revision produced. Reject it and correct it through a new draft.';
  END IF;

  -- 218 (C6-F1 FINAL) — the seal predicate. The submitted state is the
  -- attested state because no non-root path can have changed it: every
  -- canonical mutator is DRAFT-only and no non-root role holds a capability
  -- that writes it or injects code into an owner-run transaction. That is
  -- re-checked here instead of re-hashing the submitted corpus; the digest is
  -- never recomputed or refreshed at approve.
  SELECT x.breach INTO v_breach
    FROM phoenix_private.central_needs_capability_breaches_v1() AS x(breach)
   ORDER BY x.breach
   LIMIT 1;
  IF v_breach IS NOT NULL THEN
    RAISE EXCEPTION 'central_needs_capability_seal_breached' USING ERRCODE = '55000',
      DETAIL = v_breach,
      HINT = 'A non-root role holds a capability M218 revokes. Converge the grants (a root-of-trust action) before approving.';
  END IF;

  -- 217 (C5 §3) — E: identify the single effective predecessor ONLY. Nothing is
  -- mutated before A2 PASS.
  IF v_approved = 1 THEN
    SELECT * INTO v_predecessor
      FROM public.central_needs_plan_revisions
     WHERE plan_id = v_plan.id AND status = 'approved';
  END IF;

  -- 217 (C5 §3) — only after A-E: the distinct beneficiary organizations, then
  -- the distinct non-null target warehouses, each FOR SHARE ORDER BY id, so the
  -- eligibility judged below cannot change until this transaction ends.
  PERFORM 1
    FROM public.organizations o
   WHERE o.id IN (SELECT n.beneficiary_organization_id
                    FROM public.central_needs_need_lines n
                   WHERE n.plan_revision_id = p_plan_revision_id)
   ORDER BY o.id
   FOR SHARE;
  PERFORM 1
    FROM public.warehouses w
   WHERE w.id IN (SELECT n.target_warehouse_id
                    FROM public.central_needs_need_lines n
                   WHERE n.plan_revision_id = p_plan_revision_id
                     AND n.target_warehouse_id IS NOT NULL)
   ORDER BY w.id
   FOR SHARE;

  -- 217 (C5 §4) — A2: approval-time eligibility. Lines by id ASC; for each,
  -- the beneficiary before the warehouse; inactive wins over archived and
  -- not_owned over not_active. The first failure refuses the approval with
  -- the readiness blocker it corresponds to; nothing has been written yet.
  FOR v_line IN
    SELECT n.id, n.beneficiary_organization_id, n.target_warehouse_id
      FROM public.central_needs_need_lines n
     WHERE n.plan_revision_id = p_plan_revision_id
     ORDER BY n.id
  LOOP
    v_reason := NULL;
    SELECT o.organization_kind, o.status, o.archived_at INTO v_ben
      FROM public.organizations o
     WHERE o.id = v_line.beneficiary_organization_id;
    IF NOT FOUND THEN
      v_reason := 'not_found';
    ELSIF v_ben.organization_kind IS DISTINCT FROM 'care_institution' THEN
      v_reason := 'not_care_institution';
    ELSIF v_ben.status IS DISTINCT FROM 'active' THEN
      v_reason := 'inactive';
    ELSIF v_ben.archived_at IS NOT NULL THEN
      v_reason := 'archived';
    END IF;
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION 'central_needs_approval_eligibility_changed' USING ERRCODE = '23514',
        DETAIL = format('blocker=need_line_beneficiary_ineligible need_line=%s beneficiary=%s reason=%s',
                        v_line.id, v_line.beneficiary_organization_id, v_reason),
        HINT = 'A beneficiary became ineligible after submission. Reject the revision and correct it through a new draft.';
    END IF;

    IF v_line.target_warehouse_id IS NOT NULL THEN
      SELECT w.organization_id, w.status INTO v_wh
        FROM public.warehouses w
       WHERE w.id = v_line.target_warehouse_id;
      IF NOT FOUND THEN
        v_reason := 'not_found';
        v_blocker := 'need_line_warehouse_org_mismatch';
      ELSIF v_wh.organization_id IS DISTINCT FROM v_line.beneficiary_organization_id THEN
        v_reason := 'not_owned';
        v_blocker := 'need_line_warehouse_org_mismatch';
      ELSIF v_wh.status IS DISTINCT FROM 'active' THEN
        v_reason := 'not_active';
        v_blocker := 'need_line_target_warehouse_not_active';
      END IF;
      IF v_reason IS NOT NULL THEN
        RAISE EXCEPTION 'central_needs_approval_eligibility_changed' USING ERRCODE = '23514',
          DETAIL = format('blocker=%s need_line=%s beneficiary=%s warehouse=%s reason=%s',
                          v_blocker, v_line.id, v_line.beneficiary_organization_id,
                          v_line.target_warehouse_id, v_reason),
          HINT = 'A target warehouse became ineligible after submission. Reject the revision and correct it through a new draft.';
      END IF;
    END IF;
  END LOOP;

  -- 218 (C6-F1) — the PRIVATE APPROVE attestation, written only after
  -- provenance, the seal predicate and A2 PASS, in THIS transaction: the only
  -- authority the approval fence accepts for the APPROVED transition below.
  -- It carries the sealed digest attested at submit.
  INSERT INTO phoenix_private.central_needs_lifecycle_attestations (
    plan_revision_id, organization_id, phase, contract, actor_id, txid, state_digest
  ) VALUES (
    p_plan_revision_id, v_revision.organization_id, 'approve', 'c6-f1-final-v1', v_actor, txid_current(), v_submitted_digest
  );

  -- 217 (C5 §16) — the approval-gate audit event, written only after lifecycle
  -- A-E and A2 PASS, in THIS transaction. 218: forensic history only — the
  -- fence admits the APPROVED transition below against the private APPROVE
  -- attestation above, never against this row.
  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.approval_gate', 'central_needs_plan_revision', p_plan_revision_id,
    format('revision %s', v_revision.revision_number),
    jsonb_build_object(
      'contract', 'c5-v1',
      'txid', txid_current()::text,
      'plan_id', v_plan.id,
      'revision_number', v_revision.revision_number
    )
  );

  IF v_predecessor.id IS NOT NULL THEN
    -- APPROVED -> SUPERSEDED keeps approved_by/approved_at (M209's pair CHECK
    -- allows exactly that), so the historical approval stays traceable.
    UPDATE public.central_needs_plan_revisions
       SET status = 'superseded'
     WHERE id = v_predecessor.id AND status = 'approved';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
        DETAIL = format('predecessor=%s could not be superseded', v_predecessor.id);
    END IF;
  END IF;

  UPDATE public.central_needs_plan_revisions
     SET status = 'approved', approved_by = v_actor, approved_at = now()
   WHERE id = p_plan_revision_id AND status = 'submitted';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('revision=%s could not be approved', p_plan_revision_id);
  END IF;

  -- Postcondition: exactly one effective revision. Anything else rolls the
  -- whole switch back.
  SELECT count(*) INTO v_approved
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id AND status = 'approved';
  IF v_approved <> 1 THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('plan=%s would hold %s approved revisions', v_plan.id, v_approved);
  END IF;

  IF v_predecessor.id IS NOT NULL THEN
    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_revision.organization_id, v_actor, v_actor_role,
      'central_needs.plan_revision.supersede', 'central_needs_plan_revision', v_predecessor.id,
      format('plan %s revision %s', v_plan.plan_year, v_predecessor.revision_number),
      jsonb_build_object(
        'plan_id', v_plan.id,
        'plan_year', v_plan.plan_year,
        'revision_number', v_predecessor.revision_number,
        'from_status', 'approved', 'to_status', 'superseded',
        'superseded_by_revision_id', p_plan_revision_id,
        'superseded_by_revision_number', v_revision.revision_number
      )
    );
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.approve', 'central_needs_plan_revision', p_plan_revision_id,
    format('revision %s', v_revision.revision_number),
    jsonb_build_object(
      'plan_id', v_plan.id,
      'plan_year', v_plan.plan_year,
      'revision_number', v_revision.revision_number,
      'from_status', 'submitted', 'to_status', 'approved',
      'predecessor_revision_id', v_predecessor.id,
      'predecessor_revision_number', v_predecessor.revision_number,
      'predecessor_from_status', CASE WHEN v_predecessor.id IS NULL THEN NULL ELSE 'approved' END,
      'predecessor_to_status', CASE WHEN v_predecessor.id IS NULL THEN NULL ELSE 'superseded' END,
      -- 217 (C5 §2.5/§16): correlates this approval with its same-transaction gate.
      'approval_gate_txid', txid_current()::text
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'plan_revision_id', p_plan_revision_id, 'status', 'approved',
    'plan_id', v_plan.id, 'revision_number', v_revision.revision_number,
    'superseded_revision_id', v_predecessor.id
  );
END;
$$;

COMMENT ON FUNCTION public.phoenix_central_needs_approve_revision(uuid) IS
  'C2 (215, C5 217, C6-F1 FINAL 218): approves a submitted revision (central_needs.approve). Guard order unchanged; then the owner organization FOR SHARE and live, the family lock, lifecycle A-D; (218) the PRIVATE SUBMIT attestation bound to the current row version (central_needs_submission_provenance_missing otherwise) and the seal predicate (central_needs_capability_seal_breached otherwise) — the sealed submitted state is never re-hashed; then E (the predecessor is only identified), the distinct beneficiary organizations then the distinct target warehouses FOR SHARE ORDER BY id, and A2 approval-time eligibility (central_needs_approval_eligibility_changed). Only then the PRIVATE APPROVE attestation carrying the submission digest (the only authority the approval fence accepts), the forensic approval-gate audit and the atomic switch: predecessor APPROVED -> SUPERSEDED, target SUBMITTED -> APPROVED, both audited, the approve audit carrying approval_gate_txid. Ambiguous state fails closed and is never repaired; lock and serialization errors are never translated.';

-- ----------------------------------------------------------------------------
-- 10. The ONE new trigger: BEFORE UPDATE, no column list, on the private
--     submission fence. By name it fires after the M217 approval fence and
--     before set_updated_at, and it judges only DRAFT -> SUBMITTED.
-- ----------------------------------------------------------------------------
CREATE TRIGGER central_needs_plan_revisions_c6_submission_gate
  BEFORE UPDATE ON public.central_needs_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_submission_gate_fence_v1();

COMMENT ON TRIGGER central_needs_plan_revisions_c6_submission_gate ON public.central_needs_plan_revisions IS
  'C6-F1 (218): the submission fence — a revision moves from draft to submitted only with the private same-transaction SUBMIT attestation.';

-- ----------------------------------------------------------------------------
-- 11. Capability convergence. service_role keeps SELECT on Central Needs and
--     EXECUTE on the three routines the trusted finalize-import endpoint calls
--     (api/_cn2b-core/finalize-import.ts); every other listed capability of a
--     non-root role goes. REVOKE takes no relation lock. CASCADE also removes
--     every grant a revoked holder passed on WITH GRANT OPTION. A grant this
--     role cannot revoke (another grantor) is left in place and fails VERIFY.
-- ----------------------------------------------------------------------------

-- 11a. service_role is no longer a Central Needs table writer.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.central_needs_plans,
           public.central_needs_plan_revisions,
           public.central_needs_source_files,
           public.central_needs_import_sessions,
           public.central_needs_source_records,
           public.central_needs_record_mappings,
           public.central_needs_field_overrides,
           public.central_needs_import_batches,
           public.central_needs_import_batch_entries,
           public.central_needs_beneficiary_column_mappings,
           public.central_needs_beneficiary_regions,
           public.central_needs_need_lines,
           public.central_needs_need_line_sources
  FROM service_role CASCADE;

DO $converge$
DECLARE
  r record;
BEGIN
  -- 11b. TRIGGER on every public relation, from every non-root grantee
  --      (PUBLIC included): no untrusted role attaches code to a table an
  --      owner-run SECURITY DEFINER transaction writes.
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND a.privilege_type = 'TRIGGER'
       AND a.grantee <> c.relowner
       AND (a.grantee = 0
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles x
                        WHERE x.oid = a.grantee AND NOT x.rolsuper AND x.rolname !~ '^pg_'
                          AND x.oid <> (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = current_database())))
     ORDER BY 1, 2
  LOOP
    EXECUTE format('REVOKE TRIGGER ON TABLE %s FROM %s CASCADE', r.rel, r.grantee);
  END LOOP;

  -- 11c. CREATE on schema public, from every non-root grantee: nothing but
  --      the root of trust can place an object where 'public, pg_temp'
  --      search paths resolve names.
  FOR r IN
    SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee
      FROM pg_catalog.pg_namespace n
     CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
     WHERE n.nspname = 'public'
       AND a.privilege_type = 'CREATE'
       AND a.grantee <> n.nspowner
       AND (a.grantee = 0
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles x
                        WHERE x.oid = a.grantee AND NOT x.rolsuper AND x.rolname !~ '^pg_'
                          AND x.oid <> (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = current_database())))
     ORDER BY 1
  LOOP
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %s CASCADE', r.grantee);
  END LOOP;

  -- 11d. EXECUTE on the Central Needs SECURITY DEFINER surface, from
  --      service_role, except the three routines it calls. Invoker routines
  --      confer nothing beyond the caller's own rights and are left alone.
  FOR r IN
    SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS sig
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE '%central\_needs\_%'
       AND p.prosecdef
       AND p.proname NOT IN ('_phoenix_central_needs_payload_digest_v1', 'phoenix_central_needs_apply_authoritative_replay', 'phoenix_central_needs_register_import_batch')
       AND EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a
                    WHERE a.grantee = 'service_role'::regrole AND a.privilege_type = 'EXECUTE')
     ORDER BY 1
  LOOP
    EXECUTE format('REVOKE EXECUTE ON ROUTINE %s FROM service_role CASCADE', r.sig);
  END LOOP;
END
$converge$;

-- 11e. Recurrence: future tables the migration owner creates in public no
--      longer grant service_role TRIGGER. The one default changed; the DML,
--      sequence and function EXECUTE defaults are left exactly as they are.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRIGGER ON TABLES FROM service_role;

-- ----------------------------------------------------------------------------
-- 12. Readiness performance (§12). M217's legacy-evidence blocker asks whether
--     any record of the revision's completed sessions is classified
--     invalid_evidence. Unindexed, the planner evaluates the classifier on
--     EVERY source record of EVERY revision and finds none (measured on the
--     certified corpus: 227,900 records, seconds per readiness call — the
--     dominant cost of readiness and of submit — growing with every correction
--     that re-imports the archive). M217's NOT VALID CHECK already refuses
--     invalid evidence in every new row, so this partial index holds legacy
--     rows only, and the branch becomes an index probe per session. Same
--     predicate, same answer: no readiness semantics change.
-- ----------------------------------------------------------------------------
CREATE INDEX central_needs_source_records_invalid_evidence_idx
  ON public.central_needs_source_records (import_session_id)
  WHERE public._phoenix_central_needs_review_numeric_class_v1(source_values) = 'invalid_evidence';

COMMENT ON INDEX public.central_needs_source_records_invalid_evidence_idx IS
  'C6-F1 FINAL (218) performance: the source records M217''s frozen classifier judges invalid_evidence (legacy rows only — the M217 CHECK refuses new ones), by import session. Serves the readiness blocker source_cell_value_contract_invalid without classifying every record of every revision.';

-- ----------------------------------------------------------------------------
-- 13. VERIFY — the final security gate. Catalog reads (plus one rolled-back
--     default-privilege probe). Fails the migration rather than ship a
--     half-applied contract. Sections follow the owner contract A-I, then
--     data, locks and exact names.
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_me     oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user);
  v_dba    oid := (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = current_database());
  v_priv   oid := to_regnamespace('phoenix_private');
  v_store  regclass := to_regclass('phoenix_private.central_needs_lifecycle_attestations');
  v_sig    text;
  v_code   text;
  v_src    text;
  v_tbl    text;
  v_probe  text;
  v_load   integer;
  v_draft  integer;
  v_write  integer;
  n        bigint;
BEGIN
  IF v_priv IS NULL OR v_store IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the private schema or the attestation store is missing';
  END IF;

  -- ==========================================================================
  -- A. ROOT TRUST — the migration owner owns and keeps every privilege on the
  --    Central Needs tables, the private schema, the store and the private
  --    routines; superusers and the database owner are never treated as
  --    untrusted (the seal predicate exempts them).
  -- ==========================================================================
  FOREACH v_tbl IN ARRAY ARRAY['central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files', 'central_needs_import_sessions', 'central_needs_source_records', 'central_needs_record_mappings', 'central_needs_field_overrides', 'central_needs_import_batches', 'central_needs_import_batch_entries', 'central_needs_beneficiary_column_mappings', 'central_needs_beneficiary_regions', 'central_needs_need_lines', 'central_needs_need_line_sources'] LOOP
    IF (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = ('public.' || v_tbl)::regclass) <> v_me THEN
      RAISE EXCEPTION 'VERIFY FAILED (218): public.% is not owned by the migration owner', v_tbl;
    END IF;
    FOREACH v_code IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      IF NOT has_table_privilege(v_me, ('public.' || v_tbl)::regclass, v_code) THEN
        RAISE EXCEPTION 'VERIFY FAILED (218): the owner lost % on public.%', v_code, v_tbl;
      END IF;
    END LOOP;
  END LOOP;
  IF (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.oid = v_priv) <> v_me
     OR (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = v_store) <> v_me
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_priv AND p.proowner <> v_me) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): phoenix_private, its store and its routines must be owned by the migration owner';
  END IF;

  -- ==========================================================================
  -- B/C. SERVICE_ROLE, AUTHENTICATED, ANON — and every other non-root role:
  --    the seal predicate is empty (no Central Needs or private-store write,
  --    TRUNCATE, REFERENCES, TRIGGER or MAINTAIN; no TRIGGER on any public
  --    relation; no CREATE on public or phoenix_private; no API-role-owned
  --    object there). Read-only visibility is not checked here (HC1); the
  --    explicit ACLs of the private schema and store are (D, and the store
  --    check below).
  -- ==========================================================================
  SELECT string_agg(b.breach, '; ' ORDER BY b.breach) INTO v_code
    FROM phoenix_private.central_needs_capability_breaches_v1() AS b(breach);
  IF v_code IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): a non-root capability remains: %', v_code;
  END IF;
  -- Named explicitly as well: the three capability classes of service_role.
  IF has_schema_privilege('service_role', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): service_role holds CREATE on schema public';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
              WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                AND has_table_privilege('service_role', c.oid, 'TRIGGER')) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): service_role holds TRIGGER on a public relation';
  END IF;
  FOREACH v_tbl IN ARRAY ARRAY['central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files', 'central_needs_import_sessions', 'central_needs_source_records', 'central_needs_record_mappings', 'central_needs_field_overrides', 'central_needs_import_batches', 'central_needs_import_batch_entries', 'central_needs_beneficiary_column_mappings', 'central_needs_beneficiary_regions', 'central_needs_need_lines', 'central_needs_need_line_sources'] LOOP
    IF has_table_privilege('service_role', ('public.' || v_tbl)::regclass, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
       OR has_any_column_privilege('service_role', ('public.' || v_tbl)::regclass, 'INSERT, UPDATE, REFERENCES') THEN
      RAISE EXCEPTION 'VERIFY FAILED (218): service_role can still write public.%', v_tbl;
    END IF;
  END LOOP;
  -- service_role's Central Needs SECURITY DEFINER surface is exactly the three
  -- routines the trusted finalize-import endpoint calls.
  IF (SELECT array_agg(p.proname::text ORDER BY p.proname::text COLLATE "C")
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public' AND p.proname LIKE '%central\_needs\_%' AND p.prosecdef
         AND has_function_privilege('service_role', p.oid, 'EXECUTE'))
     IS DISTINCT FROM ARRAY['_phoenix_central_needs_payload_digest_v1', 'phoenix_central_needs_apply_authoritative_replay', 'phoenix_central_needs_register_import_batch'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): service_role Central Needs SECURITY DEFINER EXECUTE is not exactly the three trusted routines';
  END IF;
  -- The store: no ACL entry for anyone but its owner (not SELECT either).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
              WHERE c.oid = v_store AND a.grantee <> c.relowner)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute att WHERE att.attrelid = v_store AND att.attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): a role other than the owner holds a privilege on the attestation store';
  END IF;

  -- ==========================================================================
  -- D. PRIVATE SCHEMA — owner-only ACL, exactly the expected objects, no
  --    default privileges, never a Data API schema.
  -- ==========================================================================
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
              CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
              WHERE n.oid = v_priv AND a.grantee <> n.nspowner) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): a role other than the owner holds a privilege on phoenix_private';
  END IF;
  IF (SELECT array_agg(c.relname::text ORDER BY c.relname::text COLLATE "C") FROM pg_catalog.pg_class c WHERE c.relnamespace = v_priv)
     IS DISTINCT FROM ARRAY['central_needs_lifecycle_attestations',
                            'central_needs_lifecycle_attestations_once_key',
                            'central_needs_lifecycle_attestations_pkey'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): phoenix_private must hold exactly the attestation store and its two indexes';
  END IF;
  IF (SELECT array_agg(p.proname::text ORDER BY p.proname::text COLLATE "C") FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_priv)
     IS DISTINCT FROM ARRAY['central_needs_approval_gate_fence_v1', 'central_needs_capability_breaches_v1',
                            'central_needs_submission_gate_fence_v1', 'central_needs_submission_state_digest_v1'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): phoenix_private must hold exactly the four security routines, one overload each';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_type t
              WHERE t.typnamespace = v_priv
                AND t.typrelid <> v_store
                AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type e WHERE e.oid = t.typelem AND e.typrelid = v_store))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_operator o WHERE o.oprnamespace = v_priv)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_collation o WHERE o.collnamespace = v_priv)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_conversion o WHERE o.connamespace = v_priv)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_opfamily o WHERE o.opfnamespace = v_priv)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d WHERE d.defaclnamespace = v_priv) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): phoenix_private holds an unexpected object or default privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) c
              WHERE c ILIKE 'pgrst.db\_schemas=%' AND c ILIKE '%phoenix\_private%') THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): phoenix_private is configured as a Data API schema';
  END IF;
  -- The store: an owner-held table, RLS on and FORCED with no policy, no
  -- sequence, no user trigger, the frozen constraint set.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = v_store AND c.relkind = 'r'
                  AND c.relrowsecurity AND c.relforcerowsecurity)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol WHERE pol.polrelid = v_store)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class s ON s.oid = d.objid AND s.relkind = 'S'
                 WHERE d.refobjid = v_store)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = v_store AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the attestation store must be a FORCE-RLS table without policy, sequence or user trigger';
  END IF;
  IF (SELECT array_agg(c.conname::text ORDER BY c.conname::text COLLATE "C") FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = v_store AND c.contype IN ('p', 'u', 'f', 'c'))
     IS DISTINCT FROM ARRAY['central_needs_lifecycle_attestations_contract_chk',
                            'central_needs_lifecycle_attestations_digest_chk',
                            'central_needs_lifecycle_attestations_once_key',
                            'central_needs_lifecycle_attestations_phase_chk',
                            'central_needs_lifecycle_attestations_pkey',
                            'central_needs_lifecycle_attestations_revision_org_fk',
                            'central_needs_lifecycle_attestations_txid_chk'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the attestation store constraints are not exactly the frozen set';
  END IF;

  -- ==========================================================================
  -- E. SECURITY DEFINER BOUNDARY AND SEARCH PATHS
  -- ==========================================================================
  -- The private routines: SECURITY INVOKER, search_path exactly pg_catalog,
  -- pg_temp and nothing else, no ACL entry but the owner's.
  FOREACH v_sig IN ARRAY ARRAY[
    'phoenix_private.central_needs_submission_state_digest_v1(uuid)',
    'phoenix_private.central_needs_capability_breaches_v1()',
    'phoenix_private.central_needs_submission_gate_fence_v1()',
    'phoenix_private.central_needs_approval_gate_fence_v1(text, public.central_needs_plan_revisions, public.central_needs_plan_revisions)'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_sig)
                    AND NOT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']) THEN
      RAISE EXCEPTION 'VERIFY FAILED (218): % is missing, SECURITY DEFINER, or not pinned to pg_catalog, pg_temp', v_sig;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                WHERE p.oid = to_regprocedure(v_sig) AND a.grantee <> p.proowner) THEN
      RAISE EXCEPTION 'VERIFY FAILED (218): internal % carries an ACL entry for a role other than its owner', v_sig;
    END IF;
  END LOOP;
  -- Submit's single-snapshot judgement relies on the digest, the seal
  -- predicate and the readiness predicate being STABLE.
  IF (SELECT provolatile FROM pg_catalog.pg_proc WHERE oid = 'phoenix_private.central_needs_submission_state_digest_v1(uuid)'::regprocedure) <> 's'
     OR (SELECT provolatile FROM pg_catalog.pg_proc WHERE oid = 'phoenix_private.central_needs_capability_breaches_v1()'::regprocedure) <> 's'
     OR (SELECT provolatile FROM pg_catalog.pg_proc WHERE oid = 'public._phoenix_central_needs_review_blockers_v1(uuid)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the digest, the seal predicate and the readiness predicate must be STABLE';
  END IF;
  -- The two hardened lifecycle RPCs: SECURITY DEFINER, jsonb, search_path
  -- pg_catalog, pg_temp; submit also carries its function-level timeout.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = 'public.phoenix_central_needs_submit_revision(uuid)'::regprocedure
                    AND p.prosecdef AND p.prorettype = 'jsonb'::regtype
                    AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp', 'statement_timeout=30s']) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): submit must be SECURITY DEFINER with search_path pg_catalog, pg_temp and statement_timeout 30s';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = 'public.phoenix_central_needs_approve_revision(uuid)'::regprocedure
                    AND p.prosecdef AND p.prorettype = 'jsonb'::regtype
                    AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): approve must be SECURITY DEFINER with search_path pg_catalog, pg_temp';
  END IF;
  -- M217's approval fence: the C5-pinned shape, no client EXECUTE, and only
  -- the qualified delegation to the private body.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = 'public._phoenix_central_needs_approval_gate_fence_v1()'::regprocedure
                    AND p.prosecdef AND p.prorettype = 'trigger'::regtype
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the M217 approval fence lost its C5-pinned shape';
  END IF;
  IF has_function_privilege('anon', 'public._phoenix_central_needs_approval_gate_fence_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._phoenix_central_needs_approval_gate_fence_v1()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._phoenix_central_needs_approval_gate_fence_v1()', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                 WHERE p.oid = 'public._phoenix_central_needs_approval_gate_fence_v1()'::regprocedure AND a.grantee = 0) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the approval fence is client-callable';
  END IF;
  v_src := (SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = 'public._phoenix_central_needs_approval_gate_fence_v1()'::regprocedure);
  IF position('PERFORM phoenix_private.central_needs_approval_gate_fence_v1(TG_OP, OLD, NEW);' IN v_src) = 0
     OR position('audit_logs' IN v_src) > 0
     OR position('central_needs_lifecycle_attestations' IN v_src) > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the approval fence must only delegate to the private body';
  END IF;
  -- Every SECURITY DEFINER routine in public or phoenix_private pins a
  -- search_path, and every schema it names (other than pg_catalog and
  -- pg_temp) exists and is creatable by the root of trust alone.
  WITH nonroot AS (
    SELECT r.oid FROM pg_catalog.pg_roles r
     WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid <> v_dba
  ),
  cfg AS (
    SELECT p.oid,
           (SELECT substr(c, 13) FROM unnest(p.proconfig) c WHERE c LIKE 'search\_path=%' LIMIT 1) AS val
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname IN ('public', 'phoenix_private') AND p.prosecdef
  ),
  ent AS (
    SELECT cfg.oid, btrim(btrim(s.s), '"') AS schema
      FROM cfg CROSS JOIN LATERAL regexp_split_to_table(cfg.val, ',') AS s(s)
     WHERE cfg.val IS NOT NULL
  )
  SELECT string_agg(q.x, '; ' ORDER BY q.x) INTO v_code
    FROM (SELECT format('%s has no pinned search_path', cfg.oid::regprocedure) AS x FROM cfg WHERE cfg.val IS NULL
          UNION ALL
          SELECT format('%s searches %s', ent.oid::regprocedure, ent.schema)
            FROM ent
           WHERE ent.schema NOT IN ('pg_catalog', 'pg_temp')
             AND (to_regnamespace(ent.schema) IS NULL
                  OR EXISTS (SELECT 1 FROM nonroot u
                              WHERE u.oid <> (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.oid = to_regnamespace(ent.schema))
                                AND has_schema_privilege(u.oid, to_regnamespace(ent.schema), 'CREATE')))) q;
  IF v_code IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): a SECURITY DEFINER search_path reaches a schema a non-root role can create in: %', v_code;
  END IF;
  -- Explicit qualification: the hardened bodies name no application relation
  -- without its schema.
  FOREACH v_sig IN ARRAY ARRAY[
    'public.phoenix_central_needs_submit_revision(uuid)',
    'public.phoenix_central_needs_approve_revision(uuid)',
    'phoenix_private.central_needs_submission_state_digest_v1(uuid)',
    'phoenix_private.central_needs_submission_gate_fence_v1()',
    'phoenix_private.central_needs_approval_gate_fence_v1(text, public.central_needs_plan_revisions, public.central_needs_plan_revisions)'
  ] LOOP
    v_src := regexp_replace((SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_sig)), '--[^\n]*', '', 'g');
    IF v_src ~* '(from|join|into|update|table)\s+(only\s+)?"?(central_needs_|audit_logs|organizations|warehouses|profiles)' THEN
      RAISE EXCEPTION 'VERIFY FAILED (218): % names an application relation without its schema', v_sig;
    END IF;
  END LOOP;

  -- ==========================================================================
  -- F. SEALING — every readiness-sensitive mutator is DRAFT-only, and no other
  --    write path into submitted state exists.
  -- ==========================================================================
  -- F1. The writer census: exactly these routines (any schema) write a
  --     Central Needs relation or the store; none does so dynamically.
  IF (SELECT array_agg(p.proname::text ORDER BY p.proname::text COLLATE "C")
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
         AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
             ~* '(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+(only\s+)?(table\s+)?("?public"?\.|"?phoenix_private"?\.)?"?central_needs_[a-z_]+')
     IS DISTINCT FROM ARRAY['phoenix_central_needs_abandon_import_session',
                         'phoenix_central_needs_apply_authoritative_replay',
                         'phoenix_central_needs_approve_revision',
                         'phoenix_central_needs_delete_need_line',
                         'phoenix_central_needs_open_correction_revision',
                         'phoenix_central_needs_open_plan_revision',
                         'phoenix_central_needs_record_field_override',
                         'phoenix_central_needs_register_import_batch',
                         'phoenix_central_needs_reject_revision',
                         'phoenix_central_needs_set_beneficiary_columns',
                         'phoenix_central_needs_set_beneficiary_regions',
                         'phoenix_central_needs_set_need_line',
                         'phoenix_central_needs_set_record_disposition',
                         'phoenix_central_needs_start_import_entry_session',
                         'phoenix_central_needs_submit_revision'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the Central Needs writer census changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
              WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
                AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mexecute\M'
                AND p.prosrc ~* 'central_needs_') THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): a routine that mentions Central Needs uses dynamic SQL';
  END IF;
  -- F2. Every readiness-sensitive row writer (and submit) loads the revision
  --     FOR UPDATE and asserts DRAFT before its first write.
  FOREACH v_sig IN ARRAY ARRAY['public.phoenix_central_needs_abandon_import_session(uuid, text)',
    'public.phoenix_central_needs_apply_authoritative_replay(uuid, text, jsonb, jsonb)',
    'public.phoenix_central_needs_delete_need_line(uuid, text, uuid[])',
    'public.phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text)',
    'public.phoenix_central_needs_register_import_batch(uuid, text, text, text, text, jsonb, jsonb, bigint, integer, jsonb)',
    'public.phoenix_central_needs_set_beneficiary_columns(uuid, jsonb, text)',
    'public.phoenix_central_needs_set_beneficiary_regions(uuid, uuid, numeric, jsonb, text, uuid[], jsonb, text)',
    'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)',
    'public.phoenix_central_needs_set_record_disposition(uuid, text, text, uuid, text)',
    'public.phoenix_central_needs_start_import_entry_session(uuid, text, text, text, jsonb, bigint, text, text)',
    'public.phoenix_central_needs_submit_revision(uuid)'] LOOP
    v_src   := regexp_replace((SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_sig)), '--[^\n]*', '', 'g');
    v_load  := position('public._phoenix_central_needs_load_revision_v1(' IN v_src);
    v_draft := position('public._phoenix_central_needs_assert_draft_v1(' IN v_src);
    v_write := coalesce((SELECT min(position(m[1] IN v_src))
                           FROM regexp_matches(v_src, '((insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+(only\s+)?(table\s+)?(public|phoenix_private)\.central_needs_[a-z_]+)', 'gi') AS m), 0);
    IF v_src IS NULL OR v_load = 0 OR v_draft = 0 OR v_write = 0 OR NOT (v_load < v_draft AND v_draft < v_write) THEN
      RAISE EXCEPTION 'VERIFY FAILED (218): % must load the revision FOR UPDATE and assert DRAFT before its first write', v_sig;
    END IF;
  END LOOP;
  -- F3. The lifecycle routines write nothing but revisions, plans and the store.
  FOREACH v_sig IN ARRAY ARRAY[
    'public.phoenix_central_needs_approve_revision(uuid)',
    'public.phoenix_central_needs_reject_revision(uuid, text)',
    'public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean)',
    'public.phoenix_central_needs_open_correction_revision(uuid, integer, uuid, text)'
  ] LOOP
    v_src := regexp_replace((SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_sig)), '--[^\n]*', '', 'g');
    IF v_src IS NULL OR EXISTS (
         SELECT 1
           FROM regexp_matches(v_src, '(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+(only\s+)?(table\s+)?(public|phoenix_private)\.(central_needs_[a-z_]+)', 'gi') AS m
          WHERE lower(m[5]) NOT IN ('central_needs_plans', 'central_needs_plan_revisions', 'central_needs_lifecycle_attestations')) THEN
      RAISE EXCEPTION 'VERIFY FAILED (218): % writes Central Needs state beyond the lifecycle', v_sig;
    END IF;
  END LOOP;
  -- F4. The DRAFT gate refuses every non-draft status; the load locks.
  v_src := (SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = 'public._phoenix_central_needs_assert_draft_v1(uuid, text)'::regprocedure);
  IF position('IF p_status <> ''draft'' THEN' IN v_src) = 0 OR position('''plan_revision_not_editable''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the DRAFT gate no longer refuses every non-draft revision';
  END IF;
  IF position('FOR UPDATE' IN (SELECT p.prosrc FROM pg_catalog.pg_proc p
                                WHERE p.oid = 'public._phoenix_central_needs_load_revision_v1(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the revision load no longer locks FOR UPDATE';
  END IF;
  -- F5. Foreign keys never write sealed state: every foreign key of a Central
  --     Needs table is RESTRICT / NO ACTION, except SET NULL on auth.users
  --     actor stamps (outside the digest).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
              WHERE c.contype = 'f'
                AND c.conrelid IN ('public.central_needs_plans'::regclass, 'public.central_needs_plan_revisions'::regclass, 'public.central_needs_source_files'::regclass, 'public.central_needs_import_sessions'::regclass, 'public.central_needs_source_records'::regclass, 'public.central_needs_record_mappings'::regclass, 'public.central_needs_field_overrides'::regclass, 'public.central_needs_import_batches'::regclass, 'public.central_needs_import_batch_entries'::regclass, 'public.central_needs_beneficiary_column_mappings'::regclass, 'public.central_needs_beneficiary_regions'::regclass, 'public.central_needs_need_lines'::regclass, 'public.central_needs_need_line_sources'::regclass)
                AND NOT (c.confdeltype IN ('a', 'r') AND c.confupdtype IN ('a', 'r'))
                AND NOT (c.confrelid = to_regclass('auth.users') AND c.confdeltype = 'n' AND c.confupdtype IN ('a', 'r'))) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): a Central Needs foreign key cascades into sealed state';
  END IF;
  -- F6. No rule or view over a Central Needs relation or the store (a view
  --     writes its base table with its owner's rights).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
               JOIN pg_catalog.pg_rewrite w ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.objid = w.oid
              WHERE d.refclassid = 'pg_catalog.pg_class'::regclass
                AND d.refobjid IN ('public.central_needs_plans'::regclass, 'public.central_needs_plan_revisions'::regclass, 'public.central_needs_source_files'::regclass, 'public.central_needs_import_sessions'::regclass, 'public.central_needs_source_records'::regclass, 'public.central_needs_record_mappings'::regclass, 'public.central_needs_field_overrides'::regclass, 'public.central_needs_import_batches'::regclass, 'public.central_needs_import_batch_entries'::regclass, 'public.central_needs_beneficiary_column_mappings'::regclass, 'public.central_needs_beneficiary_regions'::regclass, 'public.central_needs_need_lines'::regclass, 'public.central_needs_need_line_sources'::regclass, v_store)) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): a rule or view depends on a Central Needs relation';
  END IF;
  -- F7. The exact trigger inventory of the Central Needs tables (name,
  --     routine, type, enabled, no column list), and every trigger on a
  --     public relation runs a routine the root of trust owns.
  IF (SELECT array_agg(s.x ORDER BY s.x COLLATE "C")
        FROM (SELECT format('%s|%s|%s.%s|%s|%s|%s', c.relname, t.tgname, pn.nspname, p.proname,
                            t.tgtype, t.tgenabled, cardinality(t.tgattr::int2[])) AS x
                FROM pg_catalog.pg_trigger t
                JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
                JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
                JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
               WHERE t.tgrelid IN ('public.central_needs_plans'::regclass, 'public.central_needs_plan_revisions'::regclass, 'public.central_needs_source_files'::regclass, 'public.central_needs_import_sessions'::regclass, 'public.central_needs_source_records'::regclass, 'public.central_needs_record_mappings'::regclass, 'public.central_needs_field_overrides'::regclass, 'public.central_needs_import_batches'::regclass, 'public.central_needs_import_batch_entries'::regclass, 'public.central_needs_beneficiary_column_mappings'::regclass, 'public.central_needs_beneficiary_regions'::regclass, 'public.central_needs_need_lines'::regclass, 'public.central_needs_need_line_sources'::regclass) AND NOT t.tgisinternal) s)
     IS DISTINCT FROM ARRAY['central_needs_beneficiary_column_mappings|assert_beneficiary_region_grain|public._phoenix_central_needs_assert_region_geometry_v1|21|O|0',
                         'central_needs_beneficiary_column_mappings|assert_need_line_integrity|public._phoenix_central_needs_assert_need_line_integrity_v1|25|O|0',
                         'central_needs_beneficiary_column_mappings|set_updated_at|public.phoenix_set_updated_at|19|O|0',
                         'central_needs_beneficiary_regions|assert_beneficiary_region_geometry|public._phoenix_central_needs_assert_region_geometry_v1|21|O|0',
                         'central_needs_beneficiary_regions|assert_need_line_integrity|public._phoenix_central_needs_assert_need_line_integrity_v1|29|O|0',
                         'central_needs_beneficiary_regions|central_needs_beneficiary_regions_guard|public._phoenix_central_needs_region_version_guard_v1|31|O|0',
                         'central_needs_need_line_sources|assert_need_line_integrity|public._phoenix_central_needs_assert_need_line_integrity_v1|29|O|0',
                         'central_needs_need_lines|assert_need_line_integrity|public._phoenix_central_needs_assert_need_line_integrity_v1|21|O|0',
                         'central_needs_need_lines|set_updated_at|public.phoenix_set_updated_at|19|O|0',
                         'central_needs_plan_revisions|central_needs_plan_revisions_c5_approval_gate|public._phoenix_central_needs_approval_gate_fence_v1|23|O|0',
                         'central_needs_plan_revisions|central_needs_plan_revisions_c6_submission_gate|phoenix_private.central_needs_submission_gate_fence_v1|19|O|0',
                         'central_needs_plan_revisions|set_updated_at|public.phoenix_set_updated_at|19|O|0',
                         'central_needs_plans|set_updated_at|public.phoenix_set_updated_at|19|O|0',
                         'central_needs_record_mappings|set_updated_at|public.phoenix_set_updated_at|19|O|0',
                         'central_needs_source_files|central_needs_source_files_immutable|public._phoenix_central_needs_source_immutability_v1|19|O|0',
                         'central_needs_source_records|central_needs_source_records_immutable|public._phoenix_central_needs_source_immutability_v1|19|O|0'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the Central Needs trigger inventory is not exactly the frozen set';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
               JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
               JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
               JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
               JOIN pg_catalog.pg_roles fo ON fo.oid = p.proowner
              WHERE ns.nspname = 'public' AND NOT t.tgisinternal
                AND NOT fo.rolsuper AND p.proowner <> v_dba AND p.proowner <> c.relowner) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): a trigger on a public relation runs a routine the root of trust does not own';
  END IF;

  -- ==========================================================================
  -- G. EVIDENCE — private attestations only; audit_logs is never authority.
  -- ==========================================================================
  -- G1. Only submit and approve write the store.
  IF (SELECT array_agg(p.proname::text ORDER BY p.proname::text COLLATE "C")
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
         AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
             ~* '(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+(only\s+)?(table\s+)?"?phoenix_private"?\."?central_needs_lifecycle_attestations')
     IS DISTINCT FROM ARRAY['phoenix_central_needs_approve_revision', 'phoenix_central_needs_submit_revision'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): a routine other than submit and approve writes the attestation store';
  END IF;
  -- G2. Both fence bodies consume the private store — phase, contract, txid,
  --     actor, transaction timestamp — and never audit_logs.
  FOREACH v_sig IN ARRAY ARRAY[
    'phoenix_private.central_needs_submission_gate_fence_v1()',
    'phoenix_private.central_needs_approval_gate_fence_v1(text, public.central_needs_plan_revisions, public.central_needs_plan_revisions)'
  ] LOOP
    v_src := (SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_sig));
    FOREACH v_code IN ARRAY ARRAY[
      'FROM phoenix_private.central_needs_lifecycle_attestations a',
      'a.contract         = ''c6-f1-final-v1''', 'a.txid             = txid_current()',
      'a.actor_id         = auth.uid()', 'a.created_at       = transaction_timestamp()'
    ] LOOP
      IF position(v_code IN v_src) = 0 THEN
        RAISE EXCEPTION 'VERIFY FAILED (218): % lacks %', v_sig, v_code;
      END IF;
    END LOOP;
    IF position('audit_logs' IN v_src) > 0 THEN
      RAISE EXCEPTION 'VERIFY FAILED (218): % consults audit_logs', v_sig;
    END IF;
  END LOOP;
  v_src := (SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = 'phoenix_private.central_needs_submission_gate_fence_v1()'::regprocedure);
  IF position('''central_needs_submission_gate_missing''' IN v_src) = 0
     OR position('OLD.status = ''draft'' AND NEW.status = ''submitted''' IN v_src) = 0
     OR position('a.plan_revision_id = NEW.id' IN v_src) = 0
     OR position('a.organization_id  = NEW.organization_id' IN v_src) = 0
     OR position('a.phase            = ''submit''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the submission fence does not judge exactly DRAFT -> SUBMITTED against a SUBMIT attestation of that revision';
  END IF;
  v_src := (SELECT p.prosrc FROM pg_catalog.pg_proc p
             WHERE p.oid = 'phoenix_private.central_needs_approval_gate_fence_v1(text, public.central_needs_plan_revisions, public.central_needs_plan_revisions)'::regprocedure);
  IF position('''central_needs_approval_gate_missing''' IN v_src) = 0
     OR position('p_op = ''INSERT'' OR p_old.status IS DISTINCT FROM ''approved''' IN v_src) = 0
     OR position('a.plan_revision_id = p_new.id' IN v_src) = 0
     OR position('a.organization_id  = p_new.organization_id' IN v_src) = 0
     OR position('a.phase            = ''approve''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the approval fence does not require an APPROVE attestation of that revision';
  END IF;
  -- G3. Submit: READ COMMITTED first, then load, guard, DRAFT, the seal
  --     predicate, readiness and the digest in ONE statement, the refusals,
  --     the attestation, the forensic gate audit, the transition, the audit.
  v_src := (SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = 'public.phoenix_central_needs_submit_revision(uuid)'::regprocedure);
  IF NOT (position('RAISE EXCEPTION ''central_needs_submit_requires_read_committed''' IN v_src) > 0
          AND position('RAISE EXCEPTION ''central_needs_submit_requires_read_committed''' IN v_src)
            < position('public._phoenix_central_needs_load_revision_v1(p_plan_revision_id)' IN v_src)
          AND position('public._phoenix_central_needs_load_revision_v1(p_plan_revision_id)' IN v_src)
            < position('public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_revision.status)' IN v_src)
          AND position('public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_revision.status)' IN v_src)
            < position('FROM phoenix_private.central_needs_capability_breaches_v1() AS x(breach)' IN v_src)
          AND position('FROM phoenix_private.central_needs_capability_breaches_v1() AS x(breach)' IN v_src)
            < position('SELECT b.blocker, b.detail, d.state_digest INTO v_blocker' IN v_src)
          AND position('SELECT b.blocker, b.detail, d.state_digest INTO v_blocker' IN v_src)
            < position('IF v_blocker.blocker IS NOT NULL THEN' IN v_src)
          AND position('IF v_blocker.blocker IS NOT NULL THEN' IN v_src)
            < position('v_state_digest := v_blocker.state_digest;' IN v_src)
          AND position('v_state_digest := v_blocker.state_digest;' IN v_src)
            < position('INSERT INTO phoenix_private.central_needs_lifecycle_attestations' IN v_src)
          AND position('INSERT INTO phoenix_private.central_needs_lifecycle_attestations' IN v_src)
            < position('''central_needs.plan_revision.submission_gate''' IN v_src)
          AND position('''central_needs.plan_revision.submission_gate''' IN v_src)
            < position('SET status = ''submitted''' IN v_src)
          AND position('SET status = ''submitted''' IN v_src)
            < position('''central_needs.plan_revision.submit''' IN v_src)) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): submit must check isolation, lock, assert DRAFT and the seal, judge readiness with the digest in one snapshot, then attest, transition and audit';
  END IF;
  FOREACH v_code IN ARRAY ARRAY[
    '''submit'', ''c6-f1-final-v1'', v_actor, txid_current(), v_state_digest', '''submission_state_digest''',
    'IF current_setting(''transaction_isolation'') <> ''read committed'' THEN',
    'SELECT b.blocker, b.detail, d.state_digest INTO v_blocker' || chr(10)
      || '    FROM (SELECT phoenix_private.central_needs_submission_state_digest_v1(p_plan_revision_id) AS state_digest) d' || chr(10)
      || '    LEFT JOIN LATERAL (SELECT x.blocker, x.detail' || chr(10)
      || '                         FROM public._phoenix_central_needs_review_blockers_v1(p_plan_revision_id) x' || chr(10)
      || '                        LIMIT 1) b ON true;',
    '''central_needs.edit''', '''plan_revision_not_ready_for_review''', 'RAISE EXCEPTION ''central_needs_capability_seal_breached'''
  ] LOOP
    IF position(v_code IN v_src) = 0 THEN
      RAISE EXCEPTION 'VERIFY FAILED (218): submit lacks %', v_code;
    END IF;
  END LOOP;
  -- G4. Approve: provenance from the private store after lifecycle A-D, then
  --     the seal predicate, then E/A2, then the APPROVE attestation carrying
  --     the SUBMITTED digest, the forensic gate audit and the switch; the
  --     submitted state is never re-hashed.
  v_src := (SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = 'public.phoenix_central_needs_approve_revision(uuid)'::regprocedure);
  IF NOT (position('''plan_revision_not_submitted''' IN v_src) > 0
          AND position('''plan_revision_not_submitted''' IN v_src)
            < position('FROM phoenix_private.central_needs_lifecycle_attestations a' IN v_src)
          AND position('FROM phoenix_private.central_needs_lifecycle_attestations a' IN v_src)
            < position('''central_needs_submission_provenance_missing''' IN v_src)
          AND position('''central_needs_submission_provenance_missing''' IN v_src)
            < position('FROM phoenix_private.central_needs_capability_breaches_v1() AS x(breach)' IN v_src)
          AND position('FROM phoenix_private.central_needs_capability_breaches_v1() AS x(breach)' IN v_src)
            < position('FROM public.organizations o' IN v_src)
          AND position('FROM public.organizations o' IN v_src)
            < position('A target warehouse became ineligible after submission.' IN v_src)
          AND position('A target warehouse became ineligible after submission.' IN v_src)
            < position('INSERT INTO phoenix_private.central_needs_lifecycle_attestations' IN v_src)
          AND position('INSERT INTO phoenix_private.central_needs_lifecycle_attestations' IN v_src)
            < position('''central_needs.plan_revision.approval_gate''' IN v_src)
          AND position('''central_needs.plan_revision.approval_gate''' IN v_src)
            < position('SET status = ''approved''' IN v_src)) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): approve must prove provenance and the seal before A2, and attest after A2 before the switch';
  END IF;
  FOREACH v_code IN ARRAY ARRAY[
    'a.xmin             = r.xmin', 'a.created_at       = v_revision.updated_at', 'a.phase            = ''submit''',
    'a.contract         = ''c6-f1-final-v1''',
    '''approve'', ''c6-f1-final-v1'', v_actor, txid_current(), v_submitted_digest',
    '''approval_gate_txid''', '''central_needs_approval_eligibility_changed''', 'FOR SHARE',
    '_phoenix_central_needs_lock_plan_family_v1', '''superseded''', 'RAISE EXCEPTION ''central_needs_capability_seal_breached'''
  ] LOOP
    IF position(v_code IN v_src) = 0 THEN
      RAISE EXCEPTION 'VERIFY FAILED (218): approve lacks %', v_code;
    END IF;
  END LOOP;
  IF position('central_needs_submission_state_digest_v1' IN v_src) > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): approve must not re-hash the sealed submitted state';
  END IF;
  -- G5. No lifecycle routine reads audit_logs.
  FOREACH v_sig IN ARRAY ARRAY[
    'public.phoenix_central_needs_submit_revision(uuid)',
    'public.phoenix_central_needs_approve_revision(uuid)',
    'phoenix_private.central_needs_submission_gate_fence_v1()',
    'phoenix_private.central_needs_approval_gate_fence_v1(text, public.central_needs_plan_revisions, public.central_needs_plan_revisions)',
    'public._phoenix_central_needs_approval_gate_fence_v1()'
  ] LOOP
    IF (SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_sig)) ~* '(from|join)\s+(public\.)?audit_logs' THEN
      RAISE EXCEPTION 'VERIFY FAILED (218): % reads audit_logs', v_sig;
    END IF;
  END LOOP;
  -- Only readiness and submit call the readiness predicate (unchanged).
  IF (SELECT array_agg(p.proname::text ORDER BY p.proname::text COLLATE "C")
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind = 'f'
         AND p.proname <> '_phoenix_central_needs_review_blockers_v1'
         AND position('_phoenix_central_needs_review_blockers_v1' IN p.prosrc) > 0)
     IS DISTINCT FROM ARRAY['phoenix_central_needs_review_readiness', 'phoenix_central_needs_submit_revision'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): only review_readiness and submit may call the readiness predicate';
  END IF;

  -- ==========================================================================
  -- H. DEFAULT PRIVILEGES — future tables cannot reopen the class.
  -- ==========================================================================
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d
               LEFT JOIN pg_catalog.pg_namespace dn ON dn.oid = d.defaclnamespace
              CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
              WHERE d.defaclrole = v_me
                AND d.defaclobjtype = 'r'
                AND (d.defaclnamespace = 0 OR dn.nspname IN ('public', 'phoenix_private'))
                AND a.privilege_type = 'TRIGGER'
                AND a.grantee <> d.defaclrole
                AND (a.grantee = 0
                     OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles x
                                 WHERE x.oid = a.grantee AND NOT x.rolsuper AND x.rolname !~ '^pg_' AND x.oid <> v_dba))) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): a default privilege of the migration owner grants TRIGGER on future tables to a non-root role';
  END IF;
  -- The effective proof: a table the migration owner creates in public now
  -- (inside a subtransaction that is rolled back) grants no non-root role
  -- TRIGGER, and anon / authenticated nothing at all.
  BEGIN
    CREATE TABLE public.phoenix_m218_default_privilege_probe (id integer);
    SELECT string_agg(format('%s %s', r.rolname, p.priv), ', ' ORDER BY r.rolname, p.priv) INTO v_probe
      FROM pg_catalog.pg_roles r
     CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) AS p(priv)
     WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid <> v_dba AND r.oid <> v_me
       AND (p.priv = 'TRIGGER' OR r.rolname IN ('anon', 'authenticated'))
       AND has_table_privilege(r.oid, 'public.phoenix_m218_default_privilege_probe', p.priv);
    RAISE EXCEPTION USING ERRCODE = 'P2180', MESSAGE = 'm218_default_privilege_probe_rollback';
  EXCEPTION WHEN SQLSTATE 'P2180' THEN
    NULL;
  END;
  IF v_probe IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): a new public table would grant: %', v_probe;
  END IF;
  IF to_regclass('public.phoenix_m218_default_privilege_probe') IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the default-privilege probe table survived';
  END IF;

  -- ==========================================================================
  -- PERFORMANCE (§12) — the readiness index: exactly the frozen partial
  -- definition over the readiness predicate's own expression, valid and ready.
  -- ==========================================================================
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
     WHERE i.indexrelid = to_regclass('public.central_needs_source_records_invalid_evidence_idx')
       AND i.indrelid = 'public.central_needs_source_records'::regclass
       AND i.indisvalid AND i.indisready AND NOT i.indisunique AND i.indnatts = 1
       AND i.indkey[0] = (SELECT a.attnum FROM pg_catalog.pg_attribute a
                           WHERE a.attrelid = i.indrelid AND a.attname = 'import_session_id')
       AND i.indexprs IS NULL
       AND pg_catalog.pg_get_expr(i.indpred, i.indrelid)
           = '(public._phoenix_central_needs_review_numeric_class_v1(source_values) = ''invalid_evidence''::text)') THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the readiness index is missing or not the frozen partial definition';
  END IF;

  -- ==========================================================================
  -- EXACT NAMES — nothing of M218 left in public; one overload each.
  -- ==========================================================================
  IF to_regclass('public.central_needs_lifecycle_attestations') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
                 WHERE ns.nspname = 'public'
                   AND p.proname IN ('_phoenix_central_needs_submission_state_digest_v1', '_phoenix_central_needs_submission_gate_fence_v1')) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): an M218 security object exists in public';
  END IF;
  FOREACH v_code IN ARRAY ARRAY[
    '_phoenix_central_needs_approval_gate_fence_v1', 'phoenix_central_needs_submit_revision',
    'phoenix_central_needs_approve_revision', 'phoenix_central_needs_reject_revision'
  ] LOOP
    SELECT count(*) INTO n FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = v_code;
    IF n <> 1 THEN
      RAISE EXCEPTION 'VERIFY FAILED (218): % must have exactly one overload (got %)', v_code, n;
    END IF;
  END LOOP;

  -- ==========================================================================
  -- DATA — no business row written; no attestation exists yet.
  -- ==========================================================================
  IF (SELECT coalesce(md5(string_agg(id::text || ':' || status, ',' ORDER BY id)), 'empty')
        FROM public.central_needs_plan_revisions)
     IS DISTINCT FROM current_setting('phoenix_m218.revision_status', true) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): a plan revision status changed';
  END IF;
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_lifecycle_attestations) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the attestation store must start empty';
  END IF;

  -- ==========================================================================
  -- LOCKS — this transaction: above ACCESS SHARE in public only the 13
  -- Central Needs tables EXCLUSIVE (plus SHARE ROW EXCLUSIVE on plan_revisions
  -- for the store's foreign key and the one CREATE TRIGGER, SHARE on
  -- source_records for the one CREATE INDEX, and the new index's own creation
  -- lock); no advisory or tuple lock. Other sessions: no DDL-class lock on a public relation (a
  -- trigger or constraint being created elsewhere would commit after these
  -- revocations).
  -- ==========================================================================
  SELECT count(*) INTO n
    FROM pg_catalog.pg_locks l
    JOIN pg_catalog.pg_class c ON c.oid = l.relation
    JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
   WHERE l.pid = pg_backend_pid()
     AND l.locktype = 'relation'
     AND ns.nspname = 'public'
     AND l.mode <> 'AccessShareLock'
     AND NOT (c.relname IN ('central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files', 'central_needs_import_sessions', 'central_needs_source_records', 'central_needs_record_mappings', 'central_needs_field_overrides', 'central_needs_import_batches', 'central_needs_import_batch_entries', 'central_needs_beneficiary_column_mappings', 'central_needs_beneficiary_regions', 'central_needs_need_lines', 'central_needs_need_line_sources') AND l.mode = 'ExclusiveLock')
     AND NOT (c.relname = 'central_needs_plan_revisions' AND l.mode = 'ShareRowExclusiveLock')
     AND NOT (c.relname = 'central_needs_source_records' AND l.mode = 'ShareLock')
     AND c.relname <> 'central_needs_source_records_invalid_evidence_idx';
  IF n > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): % public relation lock(s) outside the lock budget', n;
  END IF;
  SELECT count(*) INTO n
    FROM pg_catalog.pg_locks l
   WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND l.mode = 'ExclusiveLock' AND l.granted
     AND l.relation IN ('public.central_needs_plans'::regclass, 'public.central_needs_plan_revisions'::regclass, 'public.central_needs_source_files'::regclass, 'public.central_needs_import_sessions'::regclass, 'public.central_needs_source_records'::regclass, 'public.central_needs_record_mappings'::regclass, 'public.central_needs_field_overrides'::regclass, 'public.central_needs_import_batches'::regclass, 'public.central_needs_import_batch_entries'::regclass, 'public.central_needs_beneficiary_column_mappings'::regclass, 'public.central_needs_beneficiary_regions'::regclass, 'public.central_needs_need_lines'::regclass, 'public.central_needs_need_line_sources'::regclass);
  IF n <> 13 THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): the activation lock is not held on all 13 Central Needs tables (got %)', n;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.pid = pg_backend_pid() AND l.locktype IN ('advisory', 'tuple')) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): an advisory or tuple lock is held';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_locks l
               JOIN pg_catalog.pg_class c ON c.oid = l.relation
               JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
              WHERE l.pid <> pg_backend_pid()
                AND l.locktype = 'relation'
                AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = current_database())
                AND ns.nspname IN ('public', 'phoenix_private')
                AND l.mode IN ('ShareRowExclusiveLock', 'AccessExclusiveLock')) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): another session holds a DDL-class lock on a public relation';
  END IF;

  -- ==========================================================================
  -- CATCH-ALL (last, so every specific check above names its own failure):
  -- I. HISTORICAL IMMUTABILITY — every routine body and trigger this
  --    migration does not deliberately replace or add is byte-identical (the
  --    M209-M217 files themselves are pinned by SHA-256 in the static suite);
  --    and every ACL entry it does not deliberately revoke is byte-identical
  --    (authenticated and anon untouched; service_role keeps SELECT and its
  --    other grants; every default privilege except service_role's public
  --    table TRIGGER).
  -- ==========================================================================
  IF (SELECT md5(coalesce(string_agg(t.x, ';' ORDER BY t.x COLLATE "C"), ''))
      FROM (
        SELECT format('F|%s.%s(%s)|%s|%s|%s|%s|%s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
                      md5(p.prosrc), p.prosecdef, p.provolatile, pg_get_userbyid(p.proowner),
                      coalesce(array_to_string(p.proconfig, ','), '')) AS x
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('public', 'auth')
           AND NOT (n.nspname = 'public' AND p.proname IN ('phoenix_central_needs_submit_revision',
                                                           'phoenix_central_needs_approve_revision',
                                                           '_phoenix_central_needs_approval_gate_fence_v1'))
        UNION ALL
        SELECT format('T|%s.%s|%s|%s|%s|%s', n.nspname, c.relname, t.tgname, t.tgfoid::regprocedure, t.tgtype, t.tgenabled)
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('public', 'auth') AND NOT t.tgisinternal
           AND t.tgname <> 'central_needs_plan_revisions_c6_submission_gate'
      ) t) IS DISTINCT FROM current_setting('phoenix_m218.untouched_functions', true) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): a routine or trigger outside the deliberate replacements changed';
  END IF;
  IF (SELECT md5(coalesce(string_agg(t.x, ';' ORDER BY t.x COLLATE "C"), ''))
      FROM (
        SELECT format('R|%s|%s|%s|%s|%s', c.relname, c.relkind,
                      CASE WHEN a.grantee = 0 THEN '-' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable) AS x
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
         WHERE n.nspname = 'public'
           AND NOT (a.privilege_type = 'TRIGGER' AND a.grantee <> c.relowner AND (a.grantee = 0 OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.oid = a.grantee AND NOT x.rolsuper AND x.rolname !~ '^pg_' AND x.oid <> (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = current_database()))))
           AND NOT (a.grantee = 'service_role'::regrole
                    AND c.relname IN ('central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files', 'central_needs_import_sessions', 'central_needs_source_records', 'central_needs_record_mappings', 'central_needs_field_overrides', 'central_needs_import_batches', 'central_needs_import_batch_entries', 'central_needs_beneficiary_column_mappings', 'central_needs_beneficiary_regions', 'central_needs_need_lines', 'central_needs_need_line_sources')
                    AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'MAINTAIN'))
        UNION ALL
        SELECT format('C|%s.%s|%s|%s|%s', c.relname, att.attname,
                      CASE WHEN a.grantee = 0 THEN '-' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable)
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_catalog.pg_attribute att ON att.attrelid = c.oid AND att.attacl IS NOT NULL
         CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
         WHERE n.nspname = 'public'
        UNION ALL
        SELECT format('F|%s(%s)|%s|%s|%s', p.proname, pg_get_function_identity_arguments(p.oid),
                      CASE WHEN a.grantee = 0 THEN '-' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable)
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
         WHERE n.nspname = 'public'
           AND NOT (a.grantee = 'service_role'::regrole AND p.prosecdef
                    AND p.proname LIKE '%central\_needs\_%' AND p.proname NOT IN ('_phoenix_central_needs_payload_digest_v1', 'phoenix_central_needs_apply_authoritative_replay', 'phoenix_central_needs_register_import_batch'))
        UNION ALL
        SELECT format('N|%s|%s|%s', CASE WHEN a.grantee = 0 THEN '-' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable)
          FROM pg_catalog.pg_namespace n
         CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
         WHERE n.nspname = 'public'
           AND NOT (a.privilege_type = 'CREATE' AND a.grantee <> n.nspowner AND (a.grantee = 0 OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.oid = a.grantee AND NOT x.rolsuper AND x.rolname !~ '^pg_' AND x.oid <> (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = current_database()))))
        UNION ALL
        SELECT format('D|%s|%s|%s|%s|%s|%s', pg_get_userbyid(d.defaclrole), coalesce(dn.nspname, '-'), d.defaclobjtype,
                      CASE WHEN a.grantee = 0 THEN '-' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable)
          FROM pg_catalog.pg_default_acl d
          LEFT JOIN pg_catalog.pg_namespace dn ON dn.oid = d.defaclnamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
         WHERE a.grantee <> d.defaclrole
           AND NOT (d.defaclobjtype = 'r' AND dn.nspname = 'public'
                    AND a.grantee = 'service_role'::regrole AND a.privilege_type = 'TRIGGER')
      ) t) IS DISTINCT FROM current_setting('phoenix_m218.untouched_acl', true) THEN
    RAISE EXCEPTION 'VERIFY FAILED (218): an ACL entry outside the deliberate revocations changed';
  END IF;
END
$verify$;

COMMIT;
