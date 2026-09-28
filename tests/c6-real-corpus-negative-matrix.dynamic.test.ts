/**
 * C6 — REAL-CORPUS NEGATIVE / ADVERSARIAL MATRIX.
 *
 * Every case runs on REAL evidence: two workbooks of the certified archive
 * (identified by entry SHA-256, extracted from the verified ZIP at run time) are
 * imported as standalone files through the real trusted endpoints —
 * upload-ticket, signed staging, finalize-import — into their own annual plans,
 * then driven through the canonical RPCs until the one step under test. Each
 * refusal asserts the exact SQLSTATE and message (and DETAIL where the contract
 * pins one) AND a zero write footprint on the revision, unless the case is
 * about what IS written.
 *
 *   N1  blank versus numeric zero
 *   N2  malformed / unsafe numeric evidence
 *   N3  unresolved material disposition
 *   N4  unresolved beneficiary mapping
 *   N5  invalid / missing beneficiary
 *   N6  region / column inconsistency
 *   N7  missing quantity provenance
 *   N8  quantity / provenance mismatch
 *   N9  unresolved unit / conversion_required
 *   N10 cross-organization access
 *   N11 unauthorized edit (RPC, table, endpoint); N11b every edit RPC ×
 *       view-only / keyless / role-ineligible / other-organization callers
 *   N12 unauthorized submit
 *   N13 unauthorized approval
 *   N14 stale revision
 *   N15 stale mapping / lineage
 *   N16 concurrency / replay conflict
 *   N17 direct approval bypass blocked by the M217 gate (service_role: by
 *       privilege, since M218-FINAL revokes its Central Needs table writes)
 *   N18 approval-time eligibility changing after submit
 *   N19 historical approved revision behaviour remains valid
 *   N20 role graph: no SET ROLE / INHERIT / ADMIN / membership path from any
 *       non-root role (anon, authenticated, service_role, phoenix_demo_purger,
 *       every other application or BYPASSRLS role) into a root-of-trust or
 *       capable role or into another role's privilege surface, and no
 *       non-root role is capable itself (capable = mutation, code injection
 *       or control; read visibility, e.g. pg_read_all_data, is not: HC1)
 *
 * PRIVILEGED SQL. Read-only inspection, organization status transitions (the
 * organization lifecycle is outside Central Needs; M202's own transitions are
 * used, never a direct archived_at write), and statements labelled ATTACK whose
 * refusal is the assertion. One adversarial fixture is written directly and
 * labelled as such (N2: a still-processing session receiving a structurally
 * invalid payload through the trusted replay RPC — a state no browser path can
 * produce, because the parser never emits it).
 * N20's non-vacuity probe creates throwaway roles and memberships inside ONE
 * transaction that is always rolled back (roles are cluster-global; nothing is
 * committed, and the case proves no probe role survives). Its GRANTs hold
 * ShareUpdateExclusiveLock on the granted roles (the owner, service_role,
 * phoenix_demo_purger, predefined roles) until that rollback: run the C6 rig
 * on a cluster no other suite is using at the same time.
 *
 * Gated on PHOENIX_RIG_PG (disposable PostgreSQL only) AND
 * PHOENIX_C6_CORPUS_ZIP; skipped — and to be reported NOT_RUN — without either.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/supabase-js', async () => (await import('./helpers/c6-certification')).supabaseJsMirror());

import { buildRig, rigAvailable } from '../tools/pg-rig/rig.mjs';
import {
  corpusConfigured, importThroughEndpoints, installC6Supabase, loadCertifiedCorpus, postJson, refusal, sha256Hex,
  tokenFor, uninstallC6Supabase, workerPreviewJson,
} from './helpers/c6-certification';
import { readZipSafely } from '../src/features/central-needs/import/zip-reader';
import { nodeInflate } from '../src/features/central-needs/import/node-inflate';
import { parseWorkbookBytes } from '../src/features/central-needs/import/parser-core';
import { DEFAULT_PARSER_LIMITS } from '../src/features/central-needs/import/contract';
import uploadTicket from '../api/_cn2b-core/upload-ticket';
import finalizeImport from '../api/_cn2b-core/finalize-import';

const run = rigAvailable() && corpusConfigured() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-0000000c6a01';
const ORG_OTHER = '00000000-0000-0000-0000-0000000c6a02';
const BENE_A = '00000000-0000-0000-0000-0000000c6a11';
const BENE_B = '00000000-0000-0000-0000-0000000c6a12';
const BENE_C = '00000000-0000-0000-0000-0000000c6a13';
const BENE_D = '00000000-0000-0000-0000-0000000c6a14';
const BENE_E = '00000000-0000-0000-0000-0000000c6a15';
const U_EDIT = '00000000-0000-0000-0000-0000000c6b01';    // view / import / edit
const U_APPROVE = '00000000-0000-0000-0000-0000000c6b02'; // view / approve
const U_VIEW = '00000000-0000-0000-0000-0000000c6b03';    // view
const U_NOPERM = '00000000-0000-0000-0000-0000000c6b04';  // eligible role, no key
const U_INST = '00000000-0000-0000-0000-0000000c6b05';    // ineligible role, every key
const U_OTHER = '00000000-0000-0000-0000-0000000c6b06';   // another owner organization, every key
const ITEM_1 = '00000000-0000-0000-0000-0000000c6c01';
const ITEM_2 = '00000000-0000-0000-0000-0000000c6c02';
const ITEM_3 = '00000000-0000-0000-0000-0000000c6c03';

/** The same two certified sample workbooks as the lifecycle suite (entry SHA-256 + 0-based coordinates only). */
const W13 = {
  entrySha256: '358e29e491089d591f6e9954cf910acb633539c1749b0b7ccab963dac2f26b28',
  rows: { 1: ITEM_1, 4: ITEM_2 } as Record<number, string>,
  beneficiaryColumns: { 7: BENE_A, 8: BENE_B, 10: BENE_C, 18: BENE_D, 36: BENE_E } as Record<number, string>,
  nonBeneficiaryColumns: [0, 1, 3, 42],
};
const W20 = {
  entrySha256: '1783024a696375272452dbbcf385e2f644e872fe8af99f026d52e2b1bf5cee49',
  row: 10, item: ITEM_3, blankCol: 7, zeroCol: 11,
  beneficiaryColumns: { 10: BENE_A, 11: BENE_B, 12: BENE_C } as Record<number, string>,
};

/**
 * N20 — the role graph, one catalog query. ROOT: a true
 * superuser or the database owner, nothing else. SOURCES: every other non-predefined role. TARGETS: CAPABILITY
 * roles (root-of-trust powers — mutation, code injection, control; never mere read visibility, M218-HC1: a hosted
 * read observer inheriting pg_read_all_data is not capable; a source holding one is reported SELF) and IDENTITY roles (a privilege surface of
 * their own: object ownership, explicit EXECUTE on a SECURITY DEFINER routine, explicit relation writes, BYPASSRLS;
 * never SELF, but a path into one is a finding). A recursive walk of pg_auth_members (+ the implicit datdba ->
 * pg_database_owner edge) records, per path, SET / INHERIT / SET-then-INHERIT / ADMIN; pg_has_role must agree with
 * it for every source x target pair. `finding` must be EMPTY.
 */
const ROLE_GRAPH = `
WITH RECURSIVE
db AS (
  SELECT d.oid, d.datdba FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()
),
cn AS (
  SELECT c.oid, c.relowner, c.relname
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files',
                       'central_needs_import_sessions', 'central_needs_source_records', 'central_needs_record_mappings',
                       'central_needs_field_overrides', 'central_needs_import_batches', 'central_needs_import_batch_entries',
                       'central_needs_beneficiary_column_mappings', 'central_needs_beneficiary_regions',
                       'central_needs_need_lines', 'central_needs_need_line_sources')
),
priv AS (
  SELECT n.oid, n.nspowner, n.nspacl FROM pg_catalog.pg_namespace n WHERE n.nspname = 'phoenix_private'
),
-- phoenix_private and every object in it, from every namespaced catalog that records an owner.
priv_obj AS (
  SELECT 'relation'::text AS kind, c.oid, c.relkind::text AS sub, c.relowner AS owner, c.relacl AS acl
    FROM pg_catalog.pg_class c JOIN priv ON c.relnamespace = priv.oid
  UNION ALL SELECT 'routine', p.oid, p.prokind::text, p.proowner, p.proacl FROM pg_catalog.pg_proc p JOIN priv ON p.pronamespace = priv.oid
  UNION ALL SELECT 'type', t.oid, t.typtype::text, t.typowner, t.typacl FROM pg_catalog.pg_type t JOIN priv ON t.typnamespace = priv.oid
  UNION ALL SELECT 'operator', o.oid, NULL, o.oprowner, NULL FROM pg_catalog.pg_operator o JOIN priv ON o.oprnamespace = priv.oid
  UNION ALL SELECT 'collation', x.oid, NULL, x.collowner, NULL FROM pg_catalog.pg_collation x JOIN priv ON x.collnamespace = priv.oid
  UNION ALL SELECT 'conversion', x.oid, NULL, x.conowner, NULL FROM pg_catalog.pg_conversion x JOIN priv ON x.connamespace = priv.oid
  UNION ALL SELECT 'operator class', x.oid, NULL, x.opcowner, NULL FROM pg_catalog.pg_opclass x JOIN priv ON x.opcnamespace = priv.oid
  UNION ALL SELECT 'operator family', x.oid, NULL, x.opfowner, NULL FROM pg_catalog.pg_opfamily x JOIN priv ON x.opfnamespace = priv.oid
  UNION ALL SELECT 'text search configuration', x.oid, NULL, x.cfgowner, NULL FROM pg_catalog.pg_ts_config x JOIN priv ON x.cfgnamespace = priv.oid
  UNION ALL SELECT 'text search dictionary', x.oid, NULL, x.dictowner, NULL FROM pg_catalog.pg_ts_dict x JOIN priv ON x.dictnamespace = priv.oid
  UNION ALL SELECT 'statistics object', x.oid, NULL, x.stxowner, NULL FROM pg_catalog.pg_statistic_ext x JOIN priv ON x.stxnamespace = priv.oid
  UNION ALL SELECT 'extension', x.oid, NULL, x.extowner, NULL FROM pg_catalog.pg_extension x JOIN priv ON x.extnamespace = priv.oid
),
role AS (
  SELECT r.oid, r.rolname, r.rolsuper, r.rolcreaterole, r.rolreplication, r.rolbypassrls FROM pg_catalog.pg_roles r
),
-- ROOT: a true superuser or the database owner, and nothing else. A Central Needs table owner is NOT root merely by
-- owning: M218 requires every CN table to be owned by the migration owner, so RG_PRECONDITION requires all 13 to
-- exist and be root-owned, and a non-root owner stays a SOURCE and is reported SELF ('Central Needs table owner').
root AS (
  SELECT r.oid FROM role r WHERE r.rolsuper
  UNION
  SELECT db.datdba FROM db
),
-- SOURCES: every role that is not root and not predefined (pg_*): anon, authenticated, service_role and every other
-- application / BYPASSRLS role in the cluster (roles are cluster-global).
source AS (
  SELECT r.oid, r.rolname
    FROM role r
   WHERE r.oid NOT IN (SELECT root.oid FROM root)
     AND r.rolname !~ '^pg_'
),
-- CAPABILITY: a role that is root or holds a root-of-trust power itself — a MUTATION, code-injection or control
-- capability (M218-HC1: READ VISIBILITY != MUTATION AUTHORITY; schema or type USAGE, SELECT and pg_read_all_data are
-- not powers — a type's USAGE is read-only and only creates dependencies — while sequence USAGE is: nextval mutates).
-- A source holding one is reported SELF, and a path into one is reported. Effective privileges (has_*_privilege)
-- count direct grants, PUBLIC, inherited membership and predefined-role powers; never a membership usable only
-- through SET ROLE (the walk handles that).
capability (oid, why) AS (
  SELECT r.oid, 'superuser' FROM role r WHERE r.rolsuper
  UNION ALL SELECT db.datdba, 'database owner' FROM db
  UNION ALL SELECT r.oid, 'predefined ' || r.rolname FROM role r
   WHERE r.rolname IN ('pg_database_owner', 'pg_write_all_data', 'pg_maintain', 'pg_execute_server_program',
                       'pg_write_server_files', 'pg_read_server_files')
  UNION ALL SELECT cn.relowner, 'Central Needs table owner' FROM cn
  UNION ALL SELECT priv.nspowner, 'phoenix_private owner' FROM priv
  UNION ALL SELECT o.owner, 'owner of a phoenix_private ' || o.kind FROM priv_obj o
  UNION ALL SELECT r.oid, 'explicit CREATE, write or EXECUTE grant on phoenix_private or an object in it'
    FROM (SELECT a.grantee, a.privilege_type, 'schema'::text AS kind, NULL::text AS sub
            FROM priv CROSS JOIN LATERAL pg_catalog.aclexplode(priv.nspacl) a WHERE priv.nspacl IS NOT NULL
          UNION ALL
          SELECT a.grantee, a.privilege_type, o.kind, o.sub
            FROM priv_obj o CROSS JOIN LATERAL pg_catalog.aclexplode(o.acl) a WHERE o.acl IS NOT NULL) g
    JOIN role r ON r.oid = g.grantee OR g.grantee = 0
   WHERE (g.kind = 'schema' AND g.privilege_type = 'CREATE')
      OR (g.kind = 'relation' AND (g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')
                                   OR (g.sub = 'S' AND g.privilege_type = 'USAGE')))
      OR (g.kind = 'routine' AND g.privilege_type = 'EXECUTE')
  UNION ALL SELECT r.oid, 'effective CREATE on schema phoenix_private'
    FROM role r CROSS JOIN priv
   WHERE pg_catalog.has_schema_privilege(r.oid, priv.oid, 'CREATE')
  UNION ALL SELECT r.oid, 'effective write on a phoenix_private relation'
    FROM role r JOIN priv_obj o ON o.kind = 'relation'
   WHERE CASE WHEN o.sub = 'S' THEN pg_catalog.has_sequence_privilege(r.oid, o.oid, 'USAGE, UPDATE')
              ELSE pg_catalog.has_table_privilege(r.oid, o.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
                   OR pg_catalog.has_any_column_privilege(r.oid, o.oid, 'INSERT, UPDATE, REFERENCES') END
  UNION ALL SELECT r.oid, 'effective EXECUTE on a phoenix_private routine'
    FROM role r JOIN priv_obj o ON o.kind = 'routine'
   WHERE pg_catalog.has_function_privilege(r.oid, o.oid, 'EXECUTE')
  UNION ALL SELECT r.oid, 'effective ' || p.priv || ' on a Central Needs table'
    FROM role r CROSS JOIN cn
    CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('TRIGGER'), ('REFERENCES'), ('MAINTAIN')) AS p(priv)
   WHERE pg_catalog.has_table_privilege(r.oid, cn.oid, p.priv)
  UNION ALL SELECT r.oid, 'effective column-level ' || p.priv || ' on a Central Needs table'
    FROM role r CROSS JOIN cn CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(priv)
   WHERE pg_catalog.has_any_column_privilege(r.oid, cn.oid, p.priv)
  UNION ALL SELECT r.oid, 'effective TRIGGER on a public relation'
    FROM role r
    JOIN pg_catalog.pg_class c ON c.relkind IN ('r', 'p', 'v', 'm', 'f')
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
   WHERE pg_catalog.has_table_privilege(r.oid, c.oid, 'TRIGGER')
  UNION ALL SELECT r.oid, 'effective CREATE on schema public' FROM role r
   WHERE pg_catalog.has_schema_privilege(r.oid, 'public', 'CREATE')
  UNION ALL SELECT r.oid, 'effective CREATE on the database' FROM role r CROSS JOIN db
   WHERE pg_catalog.has_database_privilege(r.oid, db.oid, 'CREATE')
  UNION ALL SELECT r.oid, 'CREATEROLE' FROM role r WHERE r.rolcreaterole
  UNION ALL SELECT r.oid, 'REPLICATION' FROM role r WHERE r.rolreplication
  UNION ALL SELECT p.proowner, 'owner of a routine the Central Needs lifecycle runs'
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE (n.nspname = 'public' AND p.proname ~ 'central_needs')
      OR p.oid IN (SELECT t.tgfoid FROM pg_catalog.pg_trigger t
                    WHERE t.tgrelid IN (SELECT cn.oid FROM cn UNION ALL SELECT o.oid FROM priv_obj o WHERE o.kind = 'relation'))
  -- Every routine a CN or phoenix_private relation records a dependency on (RLS policy, CHECK/FK constraint,
  -- default / generated expression, trigger, index expression): its owner can redefine what the owner-run
  -- lifecycle evaluates. Derived from pg_depend, not from names.
  UNION ALL SELECT p.proowner, 'owner of a routine a Central Needs or phoenix_private relation depends on'
    FROM pg_catalog.pg_depend d
    JOIN pg_catalog.pg_proc p ON d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND p.oid = d.refobjid
    LEFT JOIN pg_catalog.pg_policy pol ON d.classid = 'pg_catalog.pg_policy'::pg_catalog.regclass AND pol.oid = d.objid
    LEFT JOIN pg_catalog.pg_constraint con ON d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass AND con.oid = d.objid
    LEFT JOIN pg_catalog.pg_attrdef ad ON d.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass AND ad.oid = d.objid
    LEFT JOIN pg_catalog.pg_trigger tg ON d.classid = 'pg_catalog.pg_trigger'::pg_catalog.regclass AND tg.oid = d.objid
    LEFT JOIN pg_catalog.pg_index ix ON d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND ix.indexrelid = d.objid
   WHERE coalesce(pol.polrelid, con.conrelid, ad.adrelid, tg.tgrelid, ix.indrelid,
                  CASE WHEN d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass THEN d.objid END)
         IN (SELECT cn.oid FROM cn UNION ALL SELECT o.oid FROM priv_obj o WHERE o.kind = 'relation')
  -- M218 revoked the public TRIGGER default from service_role: nobody may hold TRIGGER on FUTURE public relations.
  UNION ALL SELECT r.oid, 'default privilege TRIGGER on future public relations'
    FROM pg_catalog.pg_default_acl da
    CROSS JOIN LATERAL pg_catalog.aclexplode(da.defaclacl) x
    JOIN role r ON r.oid = x.grantee OR x.grantee = 0
   WHERE da.defaclobjtype = 'r' AND x.privilege_type = 'TRIGGER'
     AND (da.defaclnamespace = 0 OR da.defaclnamespace = (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'))
),
-- IDENTITY: a role whose adoption hands over a privilege surface of its own: it owns an object here (it can ALTER it,
-- e.g. a SECURITY DEFINER routine that root-owned code calls), is an explicit grantee of EXECUTE on a SECURITY DEFINER
-- routine (service_role: the three retained Central Needs writers) or of a write privilege on any relation, or is
-- BYPASSRLS. Holding one is a source's legitimate API surface (never reported SELF); a membership path INTO one from
-- another source is a finding (e.g. authenticated -> service_role, anything -> phoenix_demo_purger).
identity (oid, why) AS (
  SELECT sd.refobjid, 'owner of an object in this database'
    FROM pg_catalog.pg_shdepend sd JOIN db ON sd.dbid = db.oid
   WHERE sd.deptype = 'o' AND sd.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
  UNION ALL SELECT p.proowner, 'owner of a SECURITY DEFINER routine' FROM pg_catalog.pg_proc p WHERE p.prosecdef
  UNION ALL SELECT a.grantee, 'explicit EXECUTE on a SECURITY DEFINER routine'
    FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
   WHERE p.prosecdef AND p.proacl IS NOT NULL AND a.grantee <> 0
  UNION ALL SELECT a.grantee, 'explicit ' || a.privilege_type || ' on a relation'
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
   WHERE c.relacl IS NOT NULL AND a.grantee <> 0
     AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')
  UNION ALL SELECT a.grantee, 'explicit column-level ' || a.privilege_type || ' on a relation'
    FROM pg_catalog.pg_attribute att CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
   WHERE att.attacl IS NOT NULL AND a.grantee <> 0 AND a.privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
  UNION ALL SELECT r.oid, 'BYPASSRLS' FROM role r WHERE r.rolbypassrls
),
target AS (
  SELECT x.oid, pg_catalog.string_agg(DISTINCT x.why, '; ' ORDER BY x.why) AS why, bool_or(x.capable) AS capable
    FROM (SELECT c.oid, c.why, true AS capable FROM capability c
          UNION ALL SELECT i.oid, i.why, false FROM identity i) x
   GROUP BY x.oid
),
-- EDGES: member -> role. Every pg_auth_members row (PG16+: one row per grantor, each with its own INHERIT, SET
-- and ADMIN option; the member's rolinherit is only the default for new grants), plus the database owner's
-- implicit membership in pg_database_owner, which pg_auth_members never records (USAGE and SET, no ADMIN;
-- PostgreSQL refuses any explicit member of pg_database_owner).
edge AS (
  SELECT m.member, m.roleid, m.inherit_option AS inh, m.set_option AS setopt, m.admin_option AS adm, false AS implicit
    FROM pg_catalog.pg_auth_members m
  UNION ALL
  SELECT db.datdba, r.oid, true, true, false, true FROM db JOIN role r ON r.rolname = 'pg_database_owner'
),
-- WALK: every path from every source over every edge, whatever its options. Per path: every hop SET (SET ROLE
-- reachable; pg_has_role SET), every hop INHERIT (privileges inherited; pg_has_role USAGE), a SET prefix then an
-- INHERIT suffix (SET ROLE into a role that inherits the target; neither pg_has_role mode sees it), any hop ADMIN
-- (that membership can be granted onward, to the source itself too), last hop ADMIN (pg_has_role WITH ADMIN OPTION).
walk (src, cur, hops, all_set, all_inh, set_then_inh, any_adm, last_adm, seen, path) AS (
  SELECT s.oid, s.oid, 0, true, true, true, false, false, ARRAY[s.oid], s.rolname::text FROM source s
  UNION ALL
  SELECT w.src, e.roleid, w.hops + 1,
         w.all_set AND e.setopt,
         w.all_inh AND e.inh,
         (w.all_set AND e.setopt) OR (w.set_then_inh AND e.inh),
         w.any_adm OR e.adm,
         e.adm IS TRUE,
         w.seen || e.roleid,
         w.path || pg_catalog.format(' -[%s%s%s%s]-> %s',
                     CASE WHEN e.inh THEN 'I' ELSE '.' END, CASE WHEN e.setopt THEN 'S' ELSE '.' END,
                     CASE WHEN e.adm THEN 'A' ELSE '.' END, CASE WHEN e.implicit THEN ' implicit' ELSE '' END,
                     pg_catalog.pg_get_userbyid(e.roleid))
    FROM walk w JOIN edge e ON e.member = w.cur
   WHERE e.roleid <> ALL (w.seen)
),
reach AS (
  SELECT w.src, w.cur AS tgt, bool_or(w.all_set) AS w_set, bool_or(w.all_inh) AS w_inh, bool_or(w.last_adm) AS w_adm
    FROM walk w WHERE w.hops > 0 GROUP BY w.src, w.cur
),
-- pg_has_role must agree with the walk, mode by mode, for every source x target pair.
crosscheck AS (
  SELECT s.oid AS src, t.oid AS tgt, t.why,
         pg_catalog.pg_has_role(s.oid, t.oid, 'MEMBER') AS m,
         pg_catalog.pg_has_role(s.oid, t.oid, 'USAGE') AS u,
         pg_catalog.pg_has_role(s.oid, t.oid, 'SET') AS st,
         pg_catalog.pg_has_role(s.oid, t.oid, 'MEMBER WITH ADMIN OPTION') AS a,
         r.tgt IS NOT NULL AS w_m, coalesce(r.w_inh, false) AS w_u, coalesce(r.w_set, false) AS w_s, coalesce(r.w_adm, false) AS w_a
    FROM source s CROSS JOIN target t LEFT JOIN reach r ON r.src = s.oid AND r.tgt = t.oid
   WHERE t.oid <> s.oid
),
-- FINDINGS, expected empty: SELF (a source holds a CAPABILITY itself), a path of any kind into any target
-- (capability or identity), or a pg_has_role / walk disagreement.
finding AS (
  SELECT s.rolname::text AS source, s.rolname::text AS target, t.why AS why_target, 'SELF'::text AS kind, s.rolname::text AS path,
         NULL::boolean AS set_reachable, NULL::boolean AS inherit_reachable, NULL::boolean AS admin_on_path
    FROM source s JOIN target t ON t.oid = s.oid AND t.capable
  UNION ALL
  SELECT s.rolname::text, pg_catalog.pg_get_userbyid(w.cur)::text, t.why,
         coalesce(nullif(concat_ws('+', CASE WHEN w.all_set THEN 'SET' END, CASE WHEN w.all_inh THEN 'INHERIT' END,
                                   CASE WHEN w.set_then_inh AND NOT w.all_set AND NOT w.all_inh THEN 'SET_THEN_INHERIT' END,
                                   CASE WHEN w.any_adm THEN 'ADMIN' END), ''), 'MEMBER_ONLY'),
         w.path, w.all_set, w.all_inh, w.any_adm
    FROM walk w JOIN source s ON s.oid = w.src JOIN target t ON t.oid = w.cur
   WHERE w.hops > 0
  UNION ALL
  SELECT s.rolname::text, pg_catalog.pg_get_userbyid(c.tgt)::text, c.why,
         'CROSSCHECK pg_has_role(member,usage,set,admin)=' || concat_ws(',', c.m, c.u, c.st, c.a)
           || ' walk=' || concat_ws(',', c.w_m, c.w_u, c.w_s, c.w_a),
         NULL, NULL, NULL, NULL
    FROM crosscheck c JOIN source s ON s.oid = c.src
   WHERE (c.m, c.u, c.st, c.a) IS DISTINCT FROM (c.w_m, c.w_u, c.w_s, c.w_a)
)
`;
/** Mutation points for the non-vacuity controls; each must occur exactly once in ROLE_GRAPH. */
const RG_IMPLICIT_DBA_EDGE = `JOIN role r ON r.rolname = 'pg_database_owner'`;
const RG_SET_STEP = 'w.all_set AND e.setopt,';
const RG_LAST_ADMIN = 'e.adm IS TRUE,';
const RG_PRECONDITION = `SELECT (SELECT count(*) FROM cn)::int AS cn_tables,
  (SELECT count(*) FROM cn WHERE cn.relowner NOT IN (SELECT root.oid FROM root))::int AS cn_not_root,
  (SELECT count(*) FROM priv)::int AS private_schema,
  ((SELECT count(*) FROM priv WHERE priv.nspowner NOT IN (SELECT root.oid FROM root))
   + (SELECT count(*) FROM priv_obj o WHERE o.owner NOT IN (SELECT root.oid FROM root)))::int AS private_not_root`;
const RG_SOURCES = 'SELECT s.rolname AS source, r.rolbypassrls AS bypassrls, pg_catalog.quote_ident(s.rolname) AS ident FROM source s JOIN pg_catalog.pg_roles r ON r.oid = s.oid ORDER BY 1';
const RG_TARGETS = 'SELECT pg_catalog.pg_get_userbyid(t.oid) AS target, pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(t.oid)) AS ident, t.capable, t.why FROM target t ORDER BY 1';
const RG_FINDINGS = 'SELECT f.* FROM finding f ORDER BY f.source, f.target, f.kind, f.path';
const RG_CROSSCHECKS = `SELECT f.* FROM finding f WHERE f.kind LIKE 'CROSSCHECK%' ORDER BY f.source, f.target`;
/**
 * N20 explicit hardening (mirrors M218 VERIFY D; outside the capability model): the EXPLICIT ACLs of phoenix_private
 * and of every relation, column and routine in it name no role but the owner. A hosted read observer's access comes
 * from pg_read_all_data and never appears here; any explicit grant — even a read — does.
 */
const RG_PRIVATE_ACL = `
  SELECT 'schema' AS kind, n.nspname::text AS object, a.privilege_type,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS grantee
    FROM pg_catalog.pg_namespace n
   CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
   WHERE n.nspname = 'phoenix_private' AND a.grantee <> n.nspowner
  UNION ALL
  SELECT 'relation', c.relname::text, a.privilege_type,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))) a
   WHERE n.nspname = 'phoenix_private' AND a.grantee <> c.relowner
  UNION ALL
  SELECT 'column', c.relname::text || '.' || att.attname::text, a.privilege_type,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
    FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid = att.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
   WHERE n.nspname = 'phoenix_private' AND att.attacl IS NOT NULL AND a.grantee <> c.relowner
  UNION ALL
  SELECT 'routine', p.oid::pg_catalog.regprocedure::text, a.privilege_type,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
   WHERE n.nspname = 'phoenix_private' AND a.grantee <> p.proowner`;
const roleGraph = (select: string, graph = ROLE_GRAPH) => `${graph}\n${select}`;
const rgMutant = (from: string, to: string) => ROLE_GRAPH.replace(from, to);

run('C6 — real-corpus negative / adversarial matrix (disposable rig) — dynamic', { timeout: 600_000 }, () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const workbook: Record<'W13' | 'W20', { bytes: Uint8Array; name: string; preview: string; sheetName: string; identity: unknown }> = {} as any;
  let year = 2030;
  const T: Record<string, string> = {};

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]), { role, commit: true });
  const rowsAs = (userId: string, sql: string, params: unknown[] = []) =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows), { role: 'authenticated' });
  const admin = <R = any>(sql: string, params: unknown[] = []): Promise<R[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));

  const OPEN = 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2,$3) AS result';
  const SUBMIT = 'SELECT public.phoenix_central_needs_submit_revision($1) AS result';
  const APPROVE = 'SELECT public.phoenix_central_needs_approve_revision($1) AS result';
  const REJECT = 'SELECT public.phoenix_central_needs_reject_revision($1,$2) AS result';
  const READINESS = 'SELECT public.phoenix_central_needs_review_readiness($1) AS result';
  const DISPOSE = 'SELECT public.phoenix_central_needs_set_record_disposition($1,$2,$3,$4,$5) AS result';
  const COLUMNS = 'SELECT public.phoenix_central_needs_set_beneficiary_columns($1,$2::jsonb,$3) AS result';
  const REGIONS = 'SELECT public.phoenix_central_needs_set_beneficiary_regions($1,$2,$3,$4::jsonb,$5,$6::uuid[],$7::jsonb,$8) AS result';
  const SET_LINE = 'SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6::jsonb,$7::uuid[],$8,$9,$10,$11) AS result';
  const DELETE_LINE = 'SELECT public.phoenix_central_needs_delete_need_line($1,$2,$3::uuid[]) AS result';
  const OVERRIDE = 'SELECT public.phoenix_central_needs_record_field_override($1,$2::jsonb,$3,$4,$5) AS result';
  const OPEN_CORRECTION = 'SELECT public.phoenix_central_needs_open_correction_revision($1,$2,$3,$4) AS result';

  const src = (rec: { id: string }, q: string | number | null | undefined, override: string | null = null) => {
    const s: Record<string, unknown> = { sourceRecordId: rec.id, appliedOverrideId: override };
    if (q !== undefined) s.designatedQuantity = q;
    return s;
  };
  const line = (rev: string, o: { bene: string | null; item: string; qty: unknown; sources: unknown; expected?: string[] | null;
    unit?: string | null; state?: string | null }, user = U_EDIT) =>
    call(user, SET_LINE, [rev, o.bene, o.item, o.qty, 'designated by the C6 reviewer',
      o.sources === null ? null : JSON.stringify(o.sources), o.expected === undefined ? [] : o.expected,
      o.unit === undefined ? 'other' : o.unit, o.state === undefined ? 'canonical' : o.state, null, null]);

  /** Everything a refused call must not have changed. */
  const footprint = async (rev: string) => (await admin(`
    SELECT (SELECT status FROM central_needs_plan_revisions WHERE id = $1) AS status,
           (SELECT count(*) FROM central_needs_plan_revisions)::int AS revisions,
           (SELECT count(*) FROM central_needs_import_sessions WHERE plan_revision_id = $1)::int AS sessions,
           (SELECT count(*) FROM central_needs_source_records r JOIN central_needs_import_sessions s ON s.id = r.import_session_id WHERE s.plan_revision_id = $1)::int AS records,
           (SELECT count(*) FROM central_needs_import_batches WHERE plan_revision_id = $1)::int AS batches,
           (SELECT count(*) FROM central_needs_record_mappings m JOIN central_needs_import_sessions s ON s.id = m.import_session_id WHERE s.plan_revision_id = $1)::int AS dispositions,
           (SELECT md5(coalesce(string_agg(m.target_entity || m.decision || coalesce(m.central_item_id::text, ''), ',' ORDER BY m.target_entity), ''))
              FROM central_needs_record_mappings m JOIN central_needs_import_sessions s ON s.id = m.import_session_id WHERE s.plan_revision_id = $1) AS disposition_state,
           (SELECT count(*) FROM central_needs_beneficiary_column_mappings WHERE plan_revision_id = $1)::int AS columns,
           (SELECT count(*) FROM central_needs_beneficiary_regions WHERE plan_revision_id = $1)::int AS regions,
           (SELECT count(*) FROM central_needs_need_lines WHERE plan_revision_id = $1)::int AS lines,
           (SELECT md5(coalesce(string_agg(n.id::text || n.approved_quantity::text, ',' ORDER BY n.id), '')) FROM central_needs_need_lines n WHERE n.plan_revision_id = $1) AS line_state,
           (SELECT count(*) FROM central_needs_need_line_sources ls JOIN central_needs_need_lines n ON n.id = ls.need_line_id WHERE n.plan_revision_id = $1)::int AS links,
           (SELECT count(*) FROM central_needs_field_overrides o JOIN central_needs_source_records r ON r.id = o.source_record_id
              JOIN central_needs_import_sessions s ON s.id = r.import_session_id WHERE s.plan_revision_id = $1)::int AS overrides,
           (SELECT count(*) FROM audit_logs)::int AS audits`, [rev]))[0];

  /** The refusal of `p`, asserted exact, with nothing written. */
  const refusedClean = async (rev: string, p: () => Promise<unknown>, expected: Record<string, unknown>) => {
    const before = await footprint(rev);
    const r = await refusal(p());
    expect(r).toMatchObject(expected);
    expect(await footprint(rev)).toEqual(before);
    return r;
  };

  const draft = async () => {
    year += 1;
    const out = await call(U_EDIT, OPEN, [ORG, year, false]);
    return { rev: out.plan_revision_id as string, year };
  };
  const importWorkbook = async (rev: string, w: 'W13' | 'W20', token = T.edit) => {
    const { ticket, finalize } = await importThroughEndpoints({ uploadTicket, finalizeImport, token, planRevisionId: rev,
      containerKind: 'file', source: workbook[w].bytes, previewJson: workbook[w].preview });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(200);
    expect(finalize!.status, JSON.stringify(finalize!.body)).toBe(200);
    return finalize!.body.importSessionIds[0] as string;
  };
  /** A persisted cell's own value as a canonical decimal string (never copied into this file). */
  const qOf = (rec: { source_values: { value: unknown } }) => {
    expect(typeof rec.source_values.value).toBe('number');
    return String(rec.source_values.value);
  };
  const recordAt = async (session: string, row: number, col: number) => (await admin(
    `SELECT id, target_entity, source_values FROM central_needs_source_records WHERE import_session_id = $1
        AND (source_provenance->'coordinate'->>'row')::int = $2 AND (source_provenance->'coordinate'->>'col')::int = $3`, [session, row, col]))[0];
  const itemFor = (w: 'W13' | 'W20', entity: string) => {
    const row = Number(/^sheet:0:row:(\d+)$/.exec(entity)?.[1] ?? -1);
    return w === 'W13' ? (W13.rows[row] ?? null) : (row === W20.row ? W20.item : null);
  };
  const disposeAll = async (session: string, w: 'W13' | 'W20', skip: string[] = []) => {
    const entities = (await admin(`SELECT DISTINCT target_entity FROM central_needs_source_records WHERE import_session_id = $1 ORDER BY 1`, [session]))
      .map((r: any) => r.target_entity as string).filter((e) => !skip.includes(e));
    for (const e of entities) {
      const item = itemFor(w, e);
      await call(U_EDIT, DISPOSE, [session, e, item ? 'mapped' : 'not_applicable', item, item ? null : 'outside the C6 certified sample']);
    }
  };
  const columnsW13 = (rev: string, session: string, overrides: Record<number, string | null> = {}) => call(U_EDIT, COLUMNS, [rev, JSON.stringify([
    ...W13.nonBeneficiaryColumns.filter((c) => !(c in overrides))
      .map((c) => ({ importSessionId: session, sheetIndex: 0, columnIndex: c, decision: 'non_beneficiary' })),
    ...Object.entries({ ...W13.beneficiaryColumns, ...overrides }).filter(([, b]) => b !== null).map(([c, b]) => ({
      importSessionId: session, sheetIndex: 0, columnIndex: Number(c), decision: 'beneficiary', beneficiaryOrganizationId: b })),
  ]), 'C6 reviewer: institution columns']);
  const regionsW20 = (rev: string, session: string, changes: unknown[], expected: string[] = [], user = U_EDIT) => call(user, REGIONS,
    [rev, session, 0, JSON.stringify(workbook.W20.identity), workbook.W20.sheetName, expected, JSON.stringify(changes), 'C6 reviewer: regions']);
  const addRegion = (c0: number, c1: number, bene: string | null) => ({ op: 'add', rowStart: W20.row, rowEnd: W20.row, columnStart: c0, columnEnd: c1,
    decision: bene ? 'beneficiary' : 'non_beneficiary', beneficiaryOrganizationId: bene });
  const W20_REGIONS = () => [addRegion(0, 9, null), ...Object.entries(W20.beneficiaryColumns).map(([c, b]) => addRegion(Number(c), Number(c), b))];
  /** All sample lines of a W13 session (exact cells, designated = the persisted value). */
  const linesW13 = async (rev: string, session: string, except: Array<[number, number]> = []) => {
    for (const [row, item] of Object.entries(W13.rows)) {
      for (const [col, bene] of Object.entries(W13.beneficiaryColumns)) {
        if (except.some(([r, c]) => r === Number(row) && c === Number(col))) continue;
        const rec = await recordAt(session, Number(row), Number(col));
        if (!rec) continue;
        await line(rev, { bene, item, qty: String(rec.source_values.value), sources: [src(rec, String(rec.source_values.value))] });
      }
    }
  };
  /** A W13 revision decided end-to-end through the canonical RPCs: ready for review. */
  const readyW13 = async () => {
    const d = await draft();
    const session = await importWorkbook(d.rev, 'W13');
    await disposeAll(session, 'W13');
    await columnsW13(d.rev, session);
    await linesW13(d.rev, session);
    expect(await call(U_VIEW, READINESS, [d.rev])).toMatchObject({ ready: true, blockers: [] });
    return { ...d, session };
  };
  const submittedW13 = async () => {
    const r = await readyW13();
    expect(await call(U_EDIT, SUBMIT, [r.rev])).toMatchObject({ status: 'submitted' });
    return r;
  };
  const blockers = async (rev: string) => (await call(U_VIEW, READINESS, [rev])).blockers as Array<{ blocker: string; detail: string }>;

  beforeAll(async () => {
    const corpus = loadCertifiedCorpus();
    const zip = await readZipSafely(corpus, DEFAULT_PARSER_LIMITS, nodeInflate);
    expect(zip.safe).toBe(true);
    for (const [key, sha] of [['W13', W13.entrySha256], ['W20', W20.entrySha256]] as const) {
      const entry = zip.entries.find((e) => e.data && sha256Hex(e.data) === sha)!;
      expect(entry, key).toBeDefined();
      const name = entry.path.split('/').pop()!;
      const browser = await parseWorkbookBytes(entry.data!, name, { runtime: 'browser_worker' });
      expect(browser.outcome).toBe('accepted');
      workbook[key] = { bytes: entry.data!, name, preview: workerPreviewJson(browser), sheetName: browser.workbook!.sheets[0].name,
        identity: { ...browser.identity, runtime: 'node' } };
    }

    rig = await buildRig();
    installC6Supabase(rig);
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ($1,'C6M-OWNER','مالك','c6m-owner','pharmacy_department_authority',NULL),
        ($2,'C6M-OTHER','جهة أخرى','c6m-other','pharmacy_department_authority',NULL),
        ($3,'C6M-A','أ','c6m-a','care_institution','hospital'), ($4,'C6M-B','ب','c6m-b','care_institution','hospital'),
        ($5,'C6M-C','ج','c6m-c','care_institution','hospital'), ($6,'C6M-D','د','c6m-d','care_institution','hospital'),
        ($7,'C6M-E','هـ','c6m-e','care_institution','hospital')`, [ORG, ORG_OTHER, BENE_A, BENE_B, BENE_C, BENE_D, BENE_E]);
      await c.query(`INSERT INTO central_items (id,name,name_ar,unit) VALUES ($1,'C6M 1','م1','box'),($2,'C6M 2','م2','other'),($3,'C6M 3','م3','other')`,
        [ITEM_1, ITEM_2, ITEM_3]);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ($1,'c6m-edit@rig'),($2,'c6m-approve@rig'),($3,'c6m-view@rig'),
        ($4,'c6m-noperm@rig'),($5,'c6m-inst@rig'),($6,'c6m-other@rig')`, [U_EDIT, U_APPROVE, U_VIEW, U_NOPERM, U_INST, U_OTHER]);
      for (const [u, org, role] of [[U_EDIT, ORG, 'central_warehouse_manager'], [U_APPROVE, ORG, 'central_warehouse_manager'],
        [U_VIEW, ORG, 'central_warehouse_manager'], [U_NOPERM, ORG, 'central_warehouse_manager'], [U_INST, ORG, 'institution_admin'],
        [U_OTHER, ORG_OTHER, 'central_warehouse_manager']] as const) {
        await c.query(`UPDATE profiles SET role=$1, status='active', organization_id=$2 WHERE id=$3`, [role, org, u]);
      }
      for (const [u, keys] of [[U_EDIT, ['view', 'import', 'edit']], [U_APPROVE, ['view', 'approve']], [U_VIEW, ['view']],
        [U_INST, ['view', 'import', 'edit', 'approve']], [U_OTHER, ['view', 'import', 'edit', 'approve']]] as const) {
        for (const k of keys) {
          await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
                           ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true`, [u, `central_needs.${k}`]);
        }
      }
    });
    for (const [k, u] of [['edit', U_EDIT], ['approve', U_APPROVE], ['view', U_VIEW], ['other', U_OTHER], ['inst', U_INST]] as const) T[k] = tokenFor(u);
  }, 900_000);

  afterAll(async () => {
    uninstallC6Supabase();
    await rig?.end();
  });

  // ==========================================================================
  it('N1 blank ≠ zero: a numeric zero in a confirmed column is OWED a line (and a "0" line is valid); a missing cell is owed nothing; blank is never a quantity', async () => {
    const d = await draft();
    const session = await importWorkbook(d.rev, 'W13');
    await disposeAll(session, 'W13');
    await columnsW13(d.rev, session);
    await linesW13(d.rev, session, [[1, 18]]); // every sample cell except S2, a numeric zero
    const s2 = await recordAt(session, 1, 18);
    expect(s2.source_values).toMatchObject({ value: 0, valueType: 'number' });
    expect(await recordAt(session, 1, 8)).toBeUndefined(); // the missing cell has no record
    const owed = (await blockers(d.rev));
    expect(owed).toEqual([{ blocker: 'beneficiary_column_cell_without_need_line',
      detail: `session=${session} sheet=0 column=18 target_entity=sheet:0:row:1 source_record=${s2.id}` }]);
    await refusedClean(d.rev, () => call(U_EDIT, SUBMIT, [d.rev]), { code: '23514', message: 'plan_revision_not_ready_for_review',
      detail: `blocker=beneficiary_column_cell_without_need_line session=${session} sheet=0 column=18 target_entity=sheet:0:row:1 source_record=${s2.id}` });
    // Blank is never a quantity: no approved quantity, an empty or absent designation — each refused, nothing written.
    await refusedClean(d.rev, () => line(d.rev, { bene: BENE_D, item: ITEM_1, qty: null, sources: [src(s2, '0')] }),
      { code: '23514', message: 'approved_quantity_required' });
    await refusedClean(d.rev, () => line(d.rev, { bene: BENE_D, item: ITEM_1, qty: '0', sources: [src(s2, '')] }),
      { code: '23514', message: 'designated_quantity_not_canonical', detail: `source_record=${s2.id}` });
    await refusedClean(d.rev, () => line(d.rev, { bene: BENE_D, item: ITEM_1, qty: '0', sources: [src(s2, undefined)] }),
      { code: '23514', message: 'source_link_requires_designated_quantity' });
    await refusedClean(d.rev, () => line(d.rev, { bene: BENE_D, item: ITEM_1, qty: '0', sources: [src(s2, null)] }),
      { code: '23514', message: 'source_link_requires_designated_quantity' });
    // The zero itself is a valid, exact quantity.
    expect(await line(d.rev, { bene: BENE_D, item: ITEM_1, qty: '0', sources: [src(s2, '0')] })).toMatchObject({ ok: true, approved_quantity: '0' });
    expect(await call(U_VIEW, READINESS, [d.rev])).toMatchObject({ ready: true, blockers: [] });
    const [persisted] = await admin(`SELECT n.approved_quantity::text AS q, ls.designated_quantity::text AS d FROM central_needs_need_lines n
      JOIN central_needs_need_line_sources ls ON ls.need_line_id = n.id WHERE ls.source_record_id = $1`, [s2.id]);
    expect(persisted).toEqual({ q: '0', d: '0' });
  });

  it('N1 blank ≠ zero at the region grain: a region over only an EXPLICIT BLANK is refused (no evidence); the zero beside it is owed', async () => {
    const d = await draft();
    const session = await importWorkbook(d.rev, 'W20');
    await disposeAll(session, 'W20');
    await refusedClean(d.rev, () => regionsW20(d.rev, session, [addRegion(W20.blankCol, W20.blankCol, BENE_A)]),
      { code: '23503', message: 'beneficiary_region_no_matching_evidence' });
    expect((await regionsW20(d.rev, session, W20_REGIONS())).ok).toBe(true);
    const zero = await recordAt(session, W20.row, W20.zeroCol);
    expect(zero.source_values).toMatchObject({ value: 0, valueType: 'number' });
    expect((await blockers(d.rev)).filter((b) => b.blocker === 'beneficiary_region_cell_without_need_line').map((b) => / column=(\d+) /.exec(b.detail)![1]).sort())
      .toEqual(['10', '11', '12']);
  });

  // ==========================================================================
  it('N2 malformed / unsafe numeric evidence: the trusted replay refuses structurally invalid cells; the designation and quantity lexeme gates refuse every unsafe form', async () => {
    const d = await draft();
    // ADVERSARIAL FIXTURE (no browser path emits it): a real workbook's own records with ONE cell made
    // structurally invalid, offered to a still-processing session through the trusted replay RPC.
    const w = JSON.parse(workbook.W13.preview);
    const tampered = JSON.parse(JSON.stringify(w.sourceRecords));
    const i = tampered.findIndex((r: any) => r.sourceProvenance.coordinate.row === 1 && r.sourceProvenance.coordinate.col === 7);
    for (const bad of [{ value: null, valueType: 'number', isFormula: false, formula: null }, { value: 250 }]) {
      tampered[i].sourceValues = bad;
      const [{ d: digest }] = await admin(`SELECT public._phoenix_central_needs_payload_digest_v1($1::jsonb) AS d`, [JSON.stringify(tampered)]);
      const started = await call(U_EDIT, 'SELECT public.phoenix_central_needs_start_import_entry_session($1,$2,$3,$4,$5::jsonb,$6,$7,$8) AS result',
        [d.rev, workbook.W13.name, W13.entrySha256, digest, JSON.stringify(w.identity), workbook.W13.bytes.byteLength, `permanent/${ORG}/${d.rev}/${W13.entrySha256}`, null]);
      const r = await refusedClean(d.rev, () => call(null, 'SELECT public.phoenix_central_needs_apply_authoritative_replay($1,$2,$3::jsonb,$4::jsonb) AS result',
        [started.import_session_id, W13.entrySha256, JSON.stringify(tampered), JSON.stringify(workbook.W13.identity)], 'service_role'),
      { code: '23514', constraint: 'central_needs_source_records_c5_value_contract' });
      expect(r.message).toMatch(/violates check constraint "central_needs_source_records_c5_value_contract"/);
      // Nothing persisted, the session stays open — and is abandoned the governed way.
      expect(await admin(`SELECT status, (SELECT count(*)::int FROM central_needs_source_records WHERE import_session_id = $1) AS n
                           FROM central_needs_import_sessions WHERE id = $1`, [started.import_session_id])).toEqual([{ status: 'processing', n: 0 }]);
      await call(U_EDIT, 'SELECT public.phoenix_central_needs_abandon_import_session($1,$2) AS result', [started.import_session_id, 'C6: refused payload']);
    }

    const r = await readyW13();
    const h2 = await recordAt(r.session, 1, 7);
    const existing = await admin(`SELECT n.id FROM central_needs_need_lines n JOIN central_needs_need_line_sources ls ON ls.need_line_id = n.id WHERE ls.source_record_id = $1`, [h2.id]);
    await call(U_EDIT, DELETE_LINE, [existing[0].id, 'C6: re-designate under test', [h2.id]]);
    const q = qOf(h2);
    // Unsafe spellings of the cell's OWN value (derived at run time), and other unsafe lexemes.
    const arabicIndic = q.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    for (const bad of ['1e3', '007', '-0', ` ${q}`, `${q} `, `${q}.`, '.5', `+${q}`, 'NaN', 'Infinity', arabicIndic, '1,000', Number(q)]) {
      await refusedClean(r.rev, () => line(r.rev, { bene: BENE_A, item: ITEM_1, qty: q, sources: [src(h2, bad as any)] }),
        { code: '23514', message: 'designated_quantity_not_canonical' });
    }
    await refusedClean(r.rev, () => line(r.rev, { bene: BENE_A, item: ITEM_1, qty: 'NaN', sources: [src(h2, q)] }),
      { code: '23514', message: 'approved_quantity_must_be_finite' });
    await refusedClean(r.rev, () => line(r.rev, { bene: BENE_A, item: ITEM_1, qty: 'Infinity', sources: [src(h2, q)] }),
      { code: '23514', message: 'approved_quantity_must_be_finite' });
    await refusedClean(r.rev, () => line(r.rev, { bene: BENE_A, item: ITEM_1, qty: '-1', sources: [src(h2, q)] }),
      { code: '23514', message: 'approved_quantity_must_not_be_negative' });
  });

  it('N2 ambiguous numeric TEXT (a real material description carrying digits) is never a quantity without an explicit, reasoned numeric override', async () => {
    const d = await draft();
    const session = await importWorkbook(d.rev, 'W13');
    await disposeAll(session, 'W13');
    // Adversarial but canonical: the reviewer declares the material-text column 1 a beneficiary column.
    await columnsW13(d.rev, session, { 1: BENE_B });
    const b5 = await recordAt(session, 4, 1);
    expect(b5.source_values.valueType).toBe('string');
    expect((await admin(`SELECT public._phoenix_central_needs_review_numeric_class_v1($1::jsonb) AS c`, [JSON.stringify(b5.source_values)]))[0].c)
      .toBe('ambiguous_numeric_text');
    // Any number a reviewer might read out of the text is refused without an override…
    const unsafe = await refusedClean(d.rev, () => line(d.rev, { bene: BENE_B, item: ITEM_2, qty: '7', sources: [src(b5, '7')] }),
      { code: '23514', message: 'need_line_quantity_lineage_unsafe' });
    expect(unsafe.detail).toMatch(new RegExp(`^session=${session} source_record=${b5.id} need_line=[0-9a-f-]{36} reason=source_quantity_requires_explicit_numeric_override$`));
    // …and with one, only the override's own value is accepted.
    const ov = await call(U_EDIT, OVERRIDE, [b5.id, JSON.stringify(8), 'C6 reviewer reading', null, null]);
    const mismatch = await refusedClean(d.rev, () => line(d.rev, { bene: BENE_B, item: ITEM_2, qty: '7', sources: [src(b5, '7', ov.override_id)] }),
      { code: '23514', message: 'need_line_quantity_lineage_unsafe' });
    expect(mismatch.detail).toMatch(/ reason=source_quantity_override_mismatch$/);
    expect(await line(d.rev, { bene: BENE_B, item: ITEM_2, qty: '8', sources: [src(b5, '8', ov.override_id)] })).toMatchObject({ ok: true });
  });

  // ==========================================================================
  it('N3 unresolved material disposition: undecided rows block submit; every malformed decision is refused', async () => {
    const d = await draft();
    const session = await importWorkbook(d.rev, 'W13');
    const entities = (await admin(`SELECT DISTINCT target_entity FROM central_needs_source_records WHERE import_session_id = $1`, [session])).length;
    const b = await blockers(d.rev);
    expect(b.map((x) => x.blocker)).toEqual(Array(entities).fill('target_entity_without_disposition'));
    const r = await refusedClean(d.rev, () => call(U_EDIT, SUBMIT, [d.rev]), { code: '23514', message: 'plan_revision_has_undecided_target_entity' });
    expect(r.detail).toMatch(new RegExp(`^session=${session} target_entity=sheet:0:row:\\d+$`));
    for (const [args, message, code] of [
      [[session, 'sheet:0:row:1', 'mapped', null, null], 'mapped_decision_requires_central_item_id', '23514'],
      [[session, 'sheet:0:row:1', 'not_applicable', null, null], 'not_applicable_decision_requires_reason', '23514'],
      [[session, 'sheet:0:row:1', 'not_applicable', ITEM_1, 'x'], 'not_applicable_decision_must_not_carry_central_item_id', '23514'],
      [[session, 'sheet:0:row:1', 'maybe', ITEM_1, null], 'decision_must_be_mapped_or_not_applicable', '23514'],
      [[session, 'sheet:0:row:999', 'mapped', ITEM_1, null], 'target_entity_not_in_import_session', 'P0002'],
      [[session, 'sheet:0:row:1', 'mapped', U_EDIT, null], 'central_item_not_found', 'P0002'],
    ] as const) {
      await refusedClean(d.rev, () => call(U_EDIT, DISPOSE, [...args]), { code, message });
    }
    // Decided but mapped rows without lines still block.
    await disposeAll(session, 'W13');
    expect(new Set((await blockers(d.rev)).map((x) => x.blocker))).toEqual(new Set(['mapped_target_entity_without_need_line', 'beneficiary_column_review_required']));
  });

  // ==========================================================================
  it('N4 unresolved beneficiary mapping: a need line on an undecided column is refused, and the column blocks review', async () => {
    const d = await draft();
    const session = await importWorkbook(d.rev, 'W13');
    await disposeAll(session, 'W13');
    const h2 = await recordAt(session, 1, 7);
    await refusedClean(d.rev, () => line(d.rev, { bene: BENE_A, item: ITEM_1, qty: qOf(h2), sources: [src(h2, qOf(h2))] }),
      { code: '23514', message: 'beneficiary_column_mapping_required' });
    expect((await blockers(d.rev)).filter((x) => x.blocker === 'beneficiary_column_review_required').map((x) => Number(/ column=(\d+) /.exec(x.detail)![1])).sort((a, b) => a - b))
      .toEqual([0, 1, 3, 7, 8, 10, 18, 36, 42]);
    const r = await refusedClean(d.rev, () => call(U_EDIT, SUBMIT, [d.rev]), { code: '23514', message: 'plan_revision_not_ready_for_review' });
    expect(r.detail).toMatch(/^blocker=(mapped_target_entity_without_need_line|beneficiary_column_review_required) /);
  });

  // ==========================================================================
  it('N5 invalid / missing beneficiary: null, unknown, not a care institution, inactive and archived-but-active are each refused at both decision grains (M213 column, M216 region) and on the line', async () => {
    const d = await draft();
    const session = await importWorkbook(d.rev, 'W13');
    await disposeAll(session, 'W13');
    const mk = async (tag: string, kind = 'care_institution') => (await admin(`INSERT INTO organizations (name,name_ar,code,organization_kind,institution_class)
      VALUES ($1,$1,$2,$3,$4) RETURNING id`, [`C6M ${tag}`, `c6m-${tag}`, kind, kind === 'care_institution' ? 'hospital' : null]))[0].id as string;
    const inactive = await mk('inactive');
    await admin(`UPDATE organizations SET status = 'inactive' WHERE id = $1`, [inactive]);
    const archived = await mk('archived');
    for (const s of ['inactive', 'suspended', 'active']) await admin(`UPDATE organizations SET status = $2 WHERE id = $1`, [archived, s]);
    expect((await admin(`SELECT status, archived_at IS NOT NULL AS archived FROM organizations WHERE id = $1`, [archived]))[0]).toEqual({ status: 'active', archived: true });
    const col = (bene: unknown, extra: Record<string, unknown> = {}) => () => call(U_EDIT, COLUMNS, [d.rev,
      JSON.stringify([{ importSessionId: session, sheetIndex: 0, columnIndex: 7, beneficiaryOrganizationId: bene, ...extra }]), 'C6 reviewer']);
    await refusedClean(d.rev, col(null), { code: '23514', message: 'beneficiary_organization_required' });
    await refusedClean(d.rev, col(U_EDIT), { code: '23503', message: 'beneficiary_organization_not_found' });
    await refusedClean(d.rev, col(ORG), { code: '23514', message: 'beneficiary_must_be_care_institution' });
    await refusedClean(d.rev, col(inactive), { code: '23514', message: 'beneficiary_organization_not_active' });
    await refusedClean(d.rev, col(archived), { code: '23514', message: 'beneficiary_organization_archived' });
    await refusedClean(d.rev, col(BENE_A, { decision: 'non_beneficiary' }),
      { code: '23514', message: 'beneficiary_column_non_beneficiary_must_not_name_beneficiary' });
    await columnsW13(d.rev, session);
    const h2 = await recordAt(session, 1, 7);
    for (const [bene, code, message] of [[null, '23514', 'beneficiary_organization_required'], [U_EDIT, '23503', 'beneficiary_organization_not_found'],
      [ORG, '23514', 'beneficiary_must_be_care_institution'], [inactive, '23514', 'beneficiary_organization_not_active'],
      [archived, '23514', 'beneficiary_organization_archived']] as const) {
      await refusedClean(d.rev, () => line(d.rev, { bene, item: ITEM_1, qty: qOf(h2), sources: [src(h2, qOf(h2))] }), { code, message });
    }
    // The M216 region grain, on a second real workbook in the same draft.
    const s20 = await importWorkbook(d.rev, 'W20');
    await disposeAll(s20, 'W20');
    const reg = (bene: string | null, decision = 'beneficiary') => () => regionsW20(d.rev, s20,
      [{ ...addRegion(10, 10, BENE_A), decision, beneficiaryOrganizationId: bene }]);
    await refusedClean(d.rev, reg(null), { code: '23514', message: 'beneficiary_region_beneficiary_required' });
    await refusedClean(d.rev, reg(BENE_A, 'non_beneficiary'), { code: '23514', message: 'beneficiary_region_non_beneficiary_must_not_name_beneficiary' });
    for (const [bene, code, message] of [[U_EDIT, '23503', 'beneficiary_organization_not_found'], [ORG, '23514', 'beneficiary_must_be_care_institution'],
      [inactive, '23514', 'beneficiary_organization_not_active'], [archived, '23514', 'beneficiary_organization_archived']] as const) {
      await refusedClean(d.rev, reg(bene), { code, message });
    }
  });

  // ==========================================================================
  it('N6 region / column inconsistency: the two decision grains can never overlap, and a line must name the beneficiary its cell was decided for', async () => {
    const d = await draft();
    const session = await importWorkbook(d.rev, 'W20');
    await disposeAll(session, 'W20');
    // An M213 decision first, then a region across it.
    await call(U_EDIT, COLUMNS, [d.rev, JSON.stringify([{ importSessionId: session, sheetIndex: 0, columnIndex: 12, beneficiaryOrganizationId: BENE_C }]), 'C6']);
    await refusedClean(d.rev, () => regionsW20(d.rev, session, [addRegion(12, 12, BENE_C)]), { code: '23514', message: 'beneficiary_region_column_already_decided' });
    // Regions first, then an M213 decision on a region-governed column.
    expect((await regionsW20(d.rev, session, [addRegion(0, 9, null), addRegion(10, 10, BENE_A), addRegion(11, 11, BENE_B)])).ok).toBe(true);
    await refusedClean(d.rev, () => call(U_EDIT, COLUMNS, [d.rev, JSON.stringify([{ importSessionId: session, sheetIndex: 0, columnIndex: 10, beneficiaryOrganizationId: BENE_A }]), 'C6']),
      { code: '23514', message: 'beneficiary_decision_grain_conflict' });
    const k11 = await recordAt(session, W20.row, 10);
    const m11 = await recordAt(session, W20.row, 12);
    const c11 = await recordAt(session, W20.row, 2);
    await refusedClean(d.rev, () => line(d.rev, { bene: BENE_B, item: ITEM_3, qty: String(k11.source_values.value), sources: [src(k11, String(k11.source_values.value))] }),
      { code: '23514', message: 'beneficiary_region_mapping_conflict' });
    await refusedClean(d.rev, () => line(d.rev, { bene: BENE_A, item: ITEM_3, qty: String(m11.source_values.value), sources: [src(m11, String(m11.source_values.value))] }),
      { code: '23514', message: 'beneficiary_column_mapping_conflict' });
    await refusedClean(d.rev, () => line(d.rev, { bene: BENE_A, item: ITEM_3, qty: '1', sources: [src(c11, '1')] }),
      { code: '23514', message: 'beneficiary_region_not_beneficiary' });
  });

  // ==========================================================================
  it('N7 missing quantity provenance: a line without its exact source cells cannot exist', async () => {
    const d = await draft();
    const session = await importWorkbook(d.rev, 'W13');
    await disposeAll(session, 'W13');
    await columnsW13(d.rev, session);
    const h2 = await recordAt(session, 1, 7);
    const q = qOf(h2);
    const base = { bene: BENE_A, item: ITEM_1, qty: q };
    await refusedClean(d.rev, () => line(d.rev, { ...base, sources: [] }), { code: '23514', message: 'need_line_requires_source_lineage' });
    await refusedClean(d.rev, () => line(d.rev, { ...base, sources: null }), { code: '23514', message: 'quantity_sources_must_be_array' });
    await refusedClean(d.rev, () => line(d.rev, { ...base, sources: [src(h2, q)], expected: null }), { code: '23514', message: 'expected_source_record_ids_required' });
    await refusedClean(d.rev, () => line(d.rev, { ...base, sources: [{ designatedQuantity: q, appliedOverrideId: null }] }),
      { code: '23514', message: 'source_link_requires_source_record_id' });
    await refusedClean(d.rev, () => line(d.rev, { ...base, sources: [{ sourceRecordId: U_EDIT, designatedQuantity: q, appliedOverrideId: null }] }),
      { code: '23503', message: 'source_record_not_found' });
  });

  // ==========================================================================
  it('N8 quantity / provenance mismatch: totals, sessions, materials and overrides must all agree with the linked cells', async () => {
    const d = await draft();
    const session = await importWorkbook(d.rev, 'W13');
    await disposeAll(session, 'W13');
    await columnsW13(d.rev, session);
    const h2 = await recordAt(session, 1, 7);
    const h5 = await recordAt(session, 4, 7);
    const q = qOf(h2);
    const more = String(Number(q) + 50);
    const d1 = await refusedClean(d.rev, () => line(d.rev, { bene: BENE_A, item: ITEM_1, qty: more, sources: [src(h2, q)] }),
      { code: '23514', message: 'need_line_quantity_provenance_mismatch' });
    expect(d1.detail).toBe(`approved=${more} existing_sum=0 added_sum=${q}`);
    await refusedClean(d.rev, () => line(d.rev, { bene: BENE_A, item: ITEM_1, qty: qOf(h5), sources: [src(h5, qOf(h5))] }),
      { code: '23514', message: 'source_link_material_mismatch' });
    const other = await draft();
    const otherSession = await importWorkbook(other.rev, 'W13');
    const foreign = await recordAt(otherSession, 1, 7);
    await refusedClean(d.rev, () => line(d.rev, { bene: BENE_A, item: ITEM_1, qty: q, sources: [src(foreign, q)] }),
      { code: '23514', message: 'source_link_session_not_in_revision' });
    const ov = await call(U_EDIT, OVERRIDE, [h5.id, JSON.stringify(Number(qOf(h5)) + 1), 'C6 reviewer', null, null]);
    await refusedClean(d.rev, () => line(d.rev, { bene: BENE_A, item: ITEM_1, qty: q, sources: [src(h2, q, ov.override_id)] }),
      { code: '23514', message: 'applied_override_does_not_match_source_record' });
    expect(await line(d.rev, { bene: BENE_A, item: ITEM_1, qty: q, sources: [src(h2, q)] })).toMatchObject({ ok: true, approved_quantity: q });
    // ATTACK: a privileged rewrite of the designated quantity breaks the approved = Σ designated invariant at COMMIT.
    const r = await refusal(admin(`UPDATE central_needs_need_line_sources SET designated_quantity = designated_quantity + 1 WHERE source_record_id = $1`, [h2.id]));
    expect(r).toMatchObject({ code: '23514', message: 'need_line_quantity_provenance_mismatch' });
    expect((await admin(`SELECT designated_quantity::text AS d FROM central_needs_need_line_sources WHERE source_record_id = $1`, [h2.id]))[0].d).toBe(q);
  });

  // ==========================================================================
  it('N9 unresolved unit: outside the vocabulary, canonical without a unit, conversion_required with one, an unknown state — each refused; conversion_required blocks submit', async () => {
    const d = await draft();
    const session = await importWorkbook(d.rev, 'W13');
    await disposeAll(session, 'W13');
    await columnsW13(d.rev, session);
    const h5 = await recordAt(session, 4, 7);
    const base = { bene: BENE_A, item: ITEM_2, qty: String(h5.source_values.value), sources: [src(h5, String(h5.source_values.value))] };
    const vocab = await refusedClean(d.rev, () => line(d.rev, { ...base, unit: 'pcs' }), { code: '23514' });
    expect(vocab.message).toMatch(/central_needs_need_lines_unit_vocab_chk/);
    await refusedClean(d.rev, () => line(d.rev, { ...base, unit: null }), { code: '23514', message: 'canonical_unit_required' });
    await refusedClean(d.rev, () => line(d.rev, { ...base, unit: 'other', state: 'conversion_required' }), { code: '23514', message: 'conversion_required_must_not_carry_unit' });
    await refusedClean(d.rev, () => line(d.rev, { ...base, unit: 'other', state: 'converted' }), { code: '23514', message: 'unit_conversion_state_invalid' });
    await refusedClean(d.rev, () => line(d.rev, { ...base, unit: 'other', state: null }), { code: '23514', message: 'unit_conversion_state_invalid' });
    const pending = await line(d.rev, { ...base, unit: null, state: 'conversion_required' });
    await linesW13(d.rev, session, [[4, 7]]);
    expect(await blockers(d.rev)).toEqual([{ blocker: 'need_line_unit_conversion_required', detail: `need_line=${pending.need_line_id} item=${ITEM_2}` }]);
    await refusedClean(d.rev, () => call(U_EDIT, SUBMIT, [d.rev]), { code: '23514', message: 'plan_revision_not_ready_for_review',
      detail: `blocker=need_line_unit_conversion_required need_line=${pending.need_line_id} item=${ITEM_2}` });
  });

  // ==========================================================================
  it('N10 cross-organization access: another owner organization with every key can neither read, import into, decide, submit nor approve', async () => {
    // Positive control: U_OTHER's keys are live — in its OWN organization it opens and reads a draft.
    const own = await call(U_OTHER, OPEN, [ORG_OTHER, 2099, false]);
    expect(own).toMatchObject({ ok: true, status: 'draft' });
    expect(await call(U_OTHER, READINESS, [own.plan_revision_id])).toMatchObject({ ok: true, ready: false });
    expect(await rowsAs(U_OTHER, 'SELECT count(*)::int AS n FROM public.central_needs_plan_revisions WHERE organization_id = $1', [ORG_OTHER])).toEqual([{ n: 1 }]);
    const r = await submittedW13();
    const d = await draft();
    const session = await importWorkbook(d.rev, 'W13');
    for (const [sql, params] of [[DISPOSE, [session, 'sheet:0:row:1', 'mapped', ITEM_1, null]], [READINESS, [d.rev]], [SUBMIT, [d.rev]],
      [COLUMNS, [d.rev, JSON.stringify([{ importSessionId: session, sheetIndex: 0, columnIndex: 7, beneficiaryOrganizationId: BENE_A }]), 'x']]] as const) {
      await refusedClean(d.rev, () => call(U_OTHER, sql, [...params]), { code: '42501', message: 'forbidden_central_needs' });
    }
    await refusedClean(r.rev, () => call(U_OTHER, APPROVE, [r.rev]), { code: '42501', message: 'forbidden_central_needs' });
    for (const t of ['central_needs_plan_revisions', 'central_needs_import_sessions', 'central_needs_source_records', 'central_needs_need_lines', 'central_needs_record_mappings']) {
      expect((await admin(`SELECT count(*)::int AS n FROM public.${t} WHERE organization_id = $1`, [ORG]))[0].n, `${t} holds owner rows`).toBeGreaterThan(0);
      expect(await rowsAs(U_OTHER, `SELECT count(*)::int AS n FROM public.${t} WHERE organization_id = $1`, [ORG]), t).toEqual([{ n: 0 }]);
    }
    const before = await footprint(d.rev);
    const ticket = await postJson(uploadTicket, T.other, '/api/central-needs/upload-ticket', { planRevisionId: d.rev, byteSize: 10 });
    expect(ticket).toMatchObject({ status: 404, body: { error: 'plan_revision_not_found' } });
    const finalize = await postJson(finalizeImport, T.other, '/api/central-needs/finalize-import', { planRevisionId: d.rev, uploadId: U_EDIT, containerKind: 'file' });
    expect(finalize).toMatchObject({ status: 404, body: { error: 'plan_revision_not_found' } });
    expect(await footprint(d.rev)).toEqual(before);
  });

  // ==========================================================================
  it('N11 unauthorized edit: view-only, keyless and role-ineligible users, anon, direct table writes and the import endpoints all fail closed', async () => {
    const d = await draft();
    const session = await importWorkbook(d.rev, 'W13');
    const args = [session, 'sheet:0:row:1', 'mapped', ITEM_1, null];
    await refusedClean(d.rev, () => call(U_VIEW, DISPOSE, args), { code: '42501', message: 'forbidden_central_needs' });
    await refusedClean(d.rev, () => call(U_NOPERM, DISPOSE, args), { code: '42501', message: 'forbidden_central_needs' });
    await refusedClean(d.rev, () => call(U_INST, DISPOSE, args), { code: '42501', message: 'forbidden_central_needs_role' });
    await refusedClean(d.rev, () => call(null, DISPOSE, args), { code: '28000', message: 'not_authenticated' });
    const anon = await refusedClean(d.rev, () => call(null, DISPOSE, args, 'anon'), { code: '42501' });
    expect(anon.message).toMatch(/permission denied for function phoenix_central_needs_set_record_disposition/);
    const t1 = await refusedClean(d.rev, () => call(U_EDIT, `INSERT INTO central_needs_record_mappings (import_session_id, organization_id, target_entity, decision, decision_reason)
      VALUES ($1,$2,'sheet:0:row:1','not_applicable','x') RETURNING id`, [session, ORG]), { code: '42501' });
    expect(t1.message).toMatch(/permission denied for table central_needs_record_mappings/);
    const t2 = await refusedClean(d.rev, () => call(U_EDIT, `UPDATE central_needs_source_records SET field_name = 'x' WHERE import_session_id = $1 RETURNING id`, [session]), { code: '42501' });
    expect(t2.message).toMatch(/permission denied for table central_needs_source_records/);
    const before = await footprint(d.rev);
    expect(await postJson(uploadTicket, T.view, '/api/central-needs/upload-ticket', { planRevisionId: d.rev, byteSize: 10 }))
      .toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await postJson(uploadTicket, T.approve, '/api/central-needs/upload-ticket', { planRevisionId: d.rev, byteSize: 10 }))
      .toMatchObject({ status: 403, body: { error: 'forbidden' } });
    // A role-ineligible caller cannot even SEE the revision (RLS role-eligibility policy), so both endpoints stop at the revision read.
    expect(await rowsAs(U_INST, 'SELECT count(*)::int AS n FROM public.central_needs_plan_revisions WHERE id = $1', [d.rev])).toEqual([{ n: 0 }]);
    expect(await postJson(uploadTicket, T.inst, '/api/central-needs/upload-ticket', { planRevisionId: d.rev, byteSize: 10 }))
      .toMatchObject({ status: 404, body: { error: 'plan_revision_not_found' } });
    expect(await postJson(finalizeImport, T.inst, '/api/central-needs/finalize-import', { planRevisionId: d.rev, uploadId: U_EDIT, containerKind: 'file' }))
      .toMatchObject({ status: 404, body: { error: 'plan_revision_not_found' } });
    expect(await postJson(finalizeImport, 'not-a-token', '/api/central-needs/finalize-import', { planRevisionId: d.rev, uploadId: U_EDIT, containerKind: 'file' }))
      .toMatchObject({ status: 401, body: { error: 'not_authenticated' } });
    expect(await footprint(d.rev)).toEqual(before);
  });

  it('N11b unauthorized edit, every edit RPC: view-only, keyless, role-ineligible and other-organization callers are refused by each write path', async () => {
    const r = await readyW13();
    const s20 = await importWorkbook(r.rev, 'W20');
    const h2 = await recordAt(r.session, 1, 7);
    const [l] = await admin(`SELECT n.id FROM central_needs_need_lines n JOIN central_needs_need_line_sources ls ON ls.need_line_id = n.id WHERE ls.source_record_id = $1`, [h2.id]);
    const writes: Array<[string, string, unknown[]]> = [
      ['set_record_disposition', DISPOSE, [r.session, 'sheet:0:row:1', 'not_applicable', null, 'x']],
      ['set_need_line', SET_LINE, [r.rev, BENE_B, ITEM_1, qOf(h2), 'x', JSON.stringify([src(h2, qOf(h2))]), [], 'box', 'canonical', null, null]],
      ['delete_need_line', DELETE_LINE, [l.id, 'x', [h2.id]]],
      ['record_field_override', OVERRIDE, [h2.id, JSON.stringify(1), 'x', null, null]],
      ['set_beneficiary_columns', COLUMNS, [r.rev, JSON.stringify([{ importSessionId: r.session, sheetIndex: 0, columnIndex: 9, decision: 'non_beneficiary' }]), 'x']],
      ['set_beneficiary_regions', REGIONS, [r.rev, s20, 0, JSON.stringify(workbook.W20.identity), workbook.W20.sheetName, [], JSON.stringify([addRegion(10, 10, BENE_A)]), 'x']],
      ['abandon_import_session', 'SELECT public.phoenix_central_needs_abandon_import_session($1,$2) AS result', [s20, 'x']],
      ['open_plan_revision', OPEN, [ORG, r.year + 500, false]],
      ['open_correction_revision', OPEN_CORRECTION, [ORG, r.year, r.rev, 'x']],
    ];
    for (const [who, u, code, message] of [['view-only', U_VIEW, '42501', 'forbidden_central_needs'], ['keyless', U_NOPERM, '42501', 'forbidden_central_needs'],
      ['role-ineligible', U_INST, '42501', 'forbidden_central_needs_role'], ['other organization', U_OTHER, '42501', 'forbidden_central_needs']] as const) {
      for (const [name, sql, params] of writes) {
        const out = await refusedClean(r.rev, () => call(u, sql, params), { code });
        expect(out.message, `${who} → ${name}`).toBe(message);
      }
    }
    expect(await call(U_VIEW, READINESS, [r.rev])).toMatchObject({ ok: true });
  });

  // ==========================================================================
  it('N12 unauthorized submit: only central_needs.edit in the owner organization submits', async () => {
    const r = await readyW13();
    for (const [u, code, message] of [[U_VIEW, '42501', 'forbidden_central_needs'], [U_APPROVE, '42501', 'forbidden_central_needs'],
      [U_NOPERM, '42501', 'forbidden_central_needs'], [U_INST, '42501', 'forbidden_central_needs_role'], [U_OTHER, '42501', 'forbidden_central_needs'],
      [null, '28000', 'not_authenticated']] as const) {
      await refusedClean(r.rev, () => call(u, SUBMIT, [r.rev]), { code, message });
    }
    const anon = await refusedClean(r.rev, () => call(null, SUBMIT, [r.rev], 'anon'), { code: '42501' });
    expect(anon.message).toMatch(/permission denied for function phoenix_central_needs_submit_revision/);
    expect((await footprint(r.rev)).status).toBe('draft');
  });

  it('N13 unauthorized approval: only central_needs.approve in the owner organization approves', async () => {
    const r = await submittedW13();
    for (const [u, code, message] of [[U_EDIT, '42501', 'forbidden_central_needs'], [U_VIEW, '42501', 'forbidden_central_needs'],
      [U_NOPERM, '42501', 'forbidden_central_needs'], [U_INST, '42501', 'forbidden_central_needs_role'], [U_OTHER, '42501', 'forbidden_central_needs'],
      [null, '28000', 'not_authenticated']] as const) {
      await refusedClean(r.rev, () => call(u, APPROVE, [r.rev]), { code, message });
      await refusedClean(r.rev, () => call(u, REJECT, [r.rev, 'not mine to reject']), { code, message });
    }
    const anon = await refusedClean(r.rev, () => call(null, APPROVE, [r.rev], 'anon'), { code: '42501' });
    expect(anon.message).toMatch(/permission denied for function phoenix_central_needs_approve_revision/);
    expect((await footprint(r.rev)).status).toBe('submitted');
  });

  // ==========================================================================
  it('N14 stale revision: a submitted revision is frozen; drafts cannot be approved; closed years need a governed correction', async () => {
    const r = await submittedW13();
    const h2 = await recordAt(r.session, 1, 7);
    for (const [sql, params] of [[SUBMIT, [r.rev]], [DISPOSE, [r.session, 'sheet:0:row:2', 'mapped', ITEM_1, null]],
      [SET_LINE, [r.rev, BENE_B, ITEM_1, '1', 'x', JSON.stringify([src(h2, '1')]), [], 'box', 'canonical', null, null]],
      [OVERRIDE, [h2.id, '1', 'x', null, null]]] as const) {
      await refusedClean(r.rev, () => call(U_EDIT, sql, [...params]), { code: '23514', message: 'plan_revision_not_editable' });
    }
    const before = await footprint(r.rev);
    expect((await importThroughEndpoints({ uploadTicket, finalizeImport, token: T.edit, planRevisionId: r.rev, containerKind: 'file',
      source: workbook.W13.bytes, previewJson: workbook.W13.preview })).ticket).toMatchObject({ status: 409, body: { error: 'plan_revision_not_editable' } });
    expect(await footprint(r.rev)).toEqual(before);
    const d = await draft();
    await refusedClean(d.rev, () => call(U_APPROVE, APPROVE, [d.rev]), { code: '23514', message: 'plan_revision_not_submitted', detail: `revision=${d.rev} status=draft` });
    expect(await call(U_APPROVE, REJECT, [r.rev, 'figures do not match the hospital return'])).toMatchObject({ status: 'rejected' });
    await refusedClean(r.rev, () => call(U_APPROVE, APPROVE, [r.rev]), { code: '23514', message: 'plan_revision_not_submitted', detail: `revision=${r.rev} status=rejected` });
    await refusedClean(r.rev, () => call(U_EDIT, OPEN, [ORG, r.year, false]), { code: '23514', message: 'plan_revision_already_closed' });
    await refusedClean(r.rev, () => call(U_EDIT, OPEN, [ORG, r.year, true]), { code: '23514', message: 'central_needs_governed_correction_required' });
  });

  // ==========================================================================
  it('N15 stale mapping / lineage: every expected-state fence refuses a stale writer', async () => {
    const r = await readyW13();
    const h2 = await recordAt(r.session, 1, 7);
    const [l] = await admin(`SELECT n.id FROM central_needs_need_lines n JOIN central_needs_need_line_sources ls ON ls.need_line_id = n.id WHERE ls.source_record_id = $1`, [h2.id]);
    const h3 = await recordAt(r.session, 2, 7);
    await refusedClean(r.rev, () => line(r.rev, { bene: BENE_A, item: ITEM_1, qty: qOf(h3), sources: [src(h3, qOf(h3))], expected: [] }),
      { code: '23514', message: 'need_line_lineage_stale', detail: `need_line=${l.id} expected_links=0 current_links=1` });
    await refusedClean(r.rev, () => call(U_EDIT, DELETE_LINE, [l.id, 'stale delete', []]), { code: '23514', message: 'need_line_lineage_stale' });
    await refusedClean(r.rev, () => call(U_EDIT, COLUMNS, [r.rev, JSON.stringify([{ importSessionId: r.session, sheetIndex: 0, columnIndex: 7,
      beneficiaryOrganizationId: BENE_B, previousDecision: 'non_beneficiary', previousBeneficiaryOrganizationId: null }]), 'stale change']),
    { code: '23514', message: 'beneficiary_column_mapping_stale' });
    // A material re-map after a line exists: the line diverges and review blocks.
    await call(U_EDIT, DISPOSE, [r.session, 'sheet:0:row:1', 'mapped', ITEM_2, null]);
    expect((await blockers(r.rev)).map((b) => b.blocker)).toContain('need_line_material_mapping_divergent');
    await refusedClean(r.rev, () => call(U_EDIT, SUBMIT, [r.rev]), { code: '23514', message: 'plan_revision_not_ready_for_review' });

    const d = await draft();
    const s20 = await importWorkbook(d.rev, 'W20');
    await disposeAll(s20, 'W20');
    expect((await regionsW20(d.rev, s20, W20_REGIONS())).ok).toBe(true);
    const active = (await admin(`SELECT version_id FROM central_needs_beneficiary_regions WHERE import_session_id = $1 AND retired_at IS NULL ORDER BY version_id`, [s20]))
      .map((v: any) => v.version_id as string);
    expect(active).toHaveLength(4);
    // A writer that believes no region exists yet is stale; one naming the current set is not.
    await refusedClean(d.rev, () => regionsW20(d.rev, s20, [{ op: 'remove', versionId: active[0] }], []), { code: '23514', message: 'beneficiary_region_stale' });
    await refusedClean(d.rev, () => regionsW20(d.rev, s20, [{ op: 'remove', versionId: active[0] }], active.slice(1)), { code: '23514', message: 'beneficiary_region_stale' });
  });

  // ==========================================================================
  /**
   * An explicitly HELD transaction (the C5 suites' pattern), so a race is forced
   * rather than hoped for: the winner holds its locks uncommitted while the
   * contender is proven — through pg_blocking_pids — to be waiting on it.
   */
  const held = async (userId: string) => {
    const c = await rig.pool.connect();
    let open = true;
    await c.query('BEGIN');
    await c.query(`SET LOCAL lock_timeout = '30s'`);
    await c.query('SET LOCAL ROLE authenticated');
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    const [{ pid }] = (await c.query('SELECT pg_backend_pid() AS pid')).rows;
    const finish = async (verb: 'COMMIT' | 'ROLLBACK') => {
      if (!open) return;
      open = false;
      try { await c.query(verb); } finally { c.release(); }
    };
    return {
      pid: pid as number,
      /** Settles to {ok,result} or {ok:false,error}; never rejects, so a blocked call can be awaited later. */
      q: (sql: string, params: unknown[]) => c.query(sql, params).then(
        (r: any) => ({ ok: true as const, result: r.rows[0].result }),
        async (e: any) => { await finish('ROLLBACK'); return { ok: false as const, error: { code: String(e.code), message: String(e.message) } }; }),
      commit: () => finish('COMMIT'),
      rollback: () => finish('ROLLBACK'),
    };
  };
  const waitBlocked = async (pid: number, by: number) => {
    for (let i = 0; i < 300; i += 1) {
      const [row] = await admin(`SELECT wait_event_type, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1`, [pid]);
      if (row && row.wait_event_type === 'Lock' && (row.blockers as number[]).includes(by)) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`backend ${pid} never waited on a lock held by ${by}`);
  };
  /** Winner runs and holds; contender starts, is PROVEN blocked by the winner; winner commits; contender settles. */
  const race = async (winner: [string, string, unknown[]], contender: [string, string, unknown[]]) => {
    const w = await held(winner[0]);
    const c = await held(contender[0]);
    try {
      const won = await w.q(winner[1], winner[2]);
      expect(won.ok, JSON.stringify(won)).toBe(true);
      const pending = c.q(contender[1], contender[2]);
      await waitBlocked(c.pid, w.pid);
      await w.commit();
      const lost = await pending;
      await c.commit();
      return { won, lost };
    } finally {
      await w.rollback();
      await c.rollback();
    }
  };

  it('N16 concurrency / replay conflict: forced races — approve/approve, approve/reject both ways, correction/correction — resolve to exactly one winner; conflicting evidence is refused', async () => {
    // Two approvers: the second WAITS on the first's family lock, then replays idempotently; one gate.
    const a = await submittedW13();
    const aa = await race([U_APPROVE, APPROVE, [a.rev]], [U_APPROVE, APPROVE, [a.rev]]);
    expect(aa.won).toMatchObject({ ok: true, result: { idempotent_replay: false, status: 'approved' } });
    expect(aa.lost).toEqual({ ok: true, result: { ok: true, idempotent_replay: true, plan_revision_id: a.rev, status: 'approved' } });
    expect((await admin(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'central_needs.plan_revision.approval_gate' AND entity_id = $1`, [a.rev]))[0].n).toBe(1);
    // Approve holding while reject waits, and reject holding while approve waits: the waiter sees the decided state.
    const b = await submittedW13();
    const ar = await race([U_APPROVE, APPROVE, [b.rev]], [U_APPROVE, REJECT, [b.rev, 'racing rejection']]);
    expect(ar.lost).toEqual({ ok: false, error: { code: '23514', message: 'plan_revision_not_submitted' } });
    expect((await footprint(b.rev)).status).toBe('approved');
    const b2 = await submittedW13();
    const ra = await race([U_APPROVE, REJECT, [b2.rev, 'racing rejection']], [U_APPROVE, APPROVE, [b2.rev]]);
    expect(ra.lost).toEqual({ ok: false, error: { code: '23514', message: 'plan_revision_not_submitted' } });
    expect((await footprint(b2.rev)).status).toBe('rejected');
    expect(await admin(`SELECT id FROM audit_logs WHERE action = 'central_needs.plan_revision.approval_gate' AND entity_id = $1`, [b2.rev])).toEqual([]);
    // Two corrections of the approved plan: the waiter finds its expected revision is no longer the latest.
    const revisionsBefore = (await footprint(a.rev)).revisions;
    const cc = await race([U_EDIT, OPEN_CORRECTION, [ORG, a.year, a.rev, 'first correction']], [U_EDIT, OPEN_CORRECTION, [ORG, a.year, a.rev, 'second correction']]);
    expect(cc.won).toMatchObject({ ok: true, result: { status: 'draft', revision_number: 2 } });
    expect(cc.lost).toEqual({ ok: false, error: { code: '23514', message: 'central_needs_revision_stale' } });
    expect((await footprint(a.rev)).revisions).toBe(revisionsBefore + 1);
    // Conflicting trusted evidence for an existing container: refused, nothing written.
    const [batch] = await admin(`SELECT * FROM central_needs_import_batches WHERE plan_revision_id = $1`, [a.rev]);
    const c = await draft();
    const cs = await importWorkbook(c.rev, 'W13');
    const [cb] = await admin(`SELECT * FROM central_needs_import_batches WHERE plan_revision_id = $1`, [c.rev]);
    await refusedClean(c.rev, () => call(null, 'SELECT public.phoenix_central_needs_register_import_batch($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb) AS result',
      [c.rev, 'file', 'a different name.xls', cb.container_sha256, cb.storage_locator,
        JSON.stringify([{ entryOrdinal: 1, archiveEntryPath: null, entrySha256: W13.entrySha256, importSessionId: cs }]),
        JSON.stringify(batch.parser_identity), cb.container_byte_size, 0, null], 'service_role'),
    { code: '23514', message: 'import_batch_already_registered_with_different_evidence' });
  });

  // ==========================================================================
  it('N17 direct approval bypass: superuser direct approvals (UPDATE and INSERT) are refused by the M217 gate, service_role\'s by privilege, with zero footprint', async () => {
    const r = await submittedW13();
    const update = `UPDATE central_needs_plan_revisions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`;
    await refusedClean(r.rev, () => admin(update, [r.rev, U_APPROVE]), { code: '23514', message: 'central_needs_approval_gate_missing', detail: `revision=${r.rev}` });
    // M218-FINAL: service_role holds no Central Needs table write privilege — refused before the gate.
    const svc = await refusedClean(r.rev, () => call(null, `${update} RETURNING id`, [r.rev, U_APPROVE], 'service_role'),
      { code: '42501', message: 'permission denied for table central_needs_plan_revisions' });
    expect(svc).toEqual({ code: '42501', message: 'permission denied for table central_needs_plan_revisions' });
    const t = await refusedClean(r.rev, () => call(U_APPROVE, `${update} RETURNING id`, [r.rev, U_APPROVE]), { code: '42501' });
    expect(t.message).toMatch(/permission denied for table central_needs_plan_revisions/);
    const [plan] = await admin(`SELECT plan_id FROM central_needs_plan_revisions WHERE id = $1`, [r.rev]);
    const ins = await refusal(admin(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, approved_by, approved_at)
                                     VALUES ($1,$2,9,'approved',$3,now()) RETURNING id`, [plan.plan_id, ORG, U_APPROVE]));
    expect(ins).toMatchObject({ code: '23514', message: 'central_needs_approval_gate_missing' });
    expect((await footprint(r.rev)).status).toBe('submitted');
  });

  // ==========================================================================
  it('N18 approval-time eligibility changing after submit: a beneficiary deactivated, then archived-but-active, after submit refuses approval with zero footprint; restored, approval proceeds', async () => {
    const r = await submittedW13();
    const status = (s: string) => admin(`UPDATE organizations SET status = $2 WHERE id = $1`, [BENE_E, s]);
    const refusedFor = async (reason: string) => {
      const refused = await refusedClean(r.rev, () => call(U_APPROVE, APPROVE, [r.rev]), { code: '23514', message: 'central_needs_approval_eligibility_changed' });
      expect(refused.detail).toMatch(new RegExp(`^blocker=need_line_beneficiary_ineligible need_line=[0-9a-f-]{36} beneficiary=${BENE_E} reason=${reason}$`));
      expect(await admin(`SELECT id FROM audit_logs WHERE action = 'central_needs.plan_revision.approval_gate' AND entity_id = $1`, [r.rev])).toEqual([]);
    };
    // The organization lifecycle (M202) is outside Central Needs: its own transitions only.
    await status('inactive');
    try {
      await refusedFor('inactive');
      await status('suspended');
      await status('active'); // ACTIVE again, but archived_at is kept: archived-but-active
      expect((await admin(`SELECT archived_at IS NOT NULL AS a FROM organizations WHERE id = $1`, [BENE_E]))[0].a).toBe(true);
      await refusedFor('archived');
    } finally {
      await status('inactive');
      await status('active'); // inactive → active clears archived_at
    }
    expect((await admin(`SELECT status, archived_at FROM organizations WHERE id = $1`, [BENE_E]))[0]).toEqual({ status: 'active', archived_at: null });
    expect(await call(U_APPROVE, APPROVE, [r.rev])).toMatchObject({ ok: true, status: 'approved' });
  });

  // ==========================================================================
  it('N19 historical approved revision: later eligibility changes and a superseding correction leave approved history valid, readable and immutable', async () => {
    const r = await submittedW13();
    expect(await call(U_APPROVE, APPROVE, [r.rev])).toMatchObject({ status: 'approved' });
    const linesBefore = await rowsAs(U_VIEW, 'SELECT * FROM public.phoenix_central_needs_list_need_lines($1) ORDER BY id', [r.rev]);
    await admin(`UPDATE organizations SET status = 'inactive' WHERE id = $1`, [BENE_C]);
    try {
      expect((await admin(`SELECT status FROM central_needs_plan_revisions WHERE id = $1`, [r.rev]))[0].status).toBe('approved');
      expect(await rowsAs(U_VIEW, 'SELECT * FROM public.phoenix_central_needs_list_need_lines($1) ORDER BY id', [r.rev])).toEqual(linesBefore);
      expect((await call(U_VIEW, 'SELECT public.phoenix_central_needs_revision_lifecycle($1,$2) AS result', [ORG, r.year])).effective_revision_id).toBe(r.rev);
      // The approved revision's immutable evidence and quantity lineage stay clean after approval and after a
      // beneficiary eligibility change. (That the §7.1/§7.2 checks are DRAFT-ONLY — never re-judging approved
      // history even when it holds invalid legacy evidence — is proven by the C5 suites:
      // 217-central-needs-c5-lifecycle-chain.dynamic.test.ts §7 and 217-central-needs-c5-safety-convergence.dynamic.test.ts.)
      expect(await admin(`SELECT count(*)::int AS n FROM public._phoenix_central_needs_review_blockers_v1($1) WHERE blocker IN ('source_cell_value_contract_invalid','need_line_quantity_lineage_unsafe')`, [r.rev]))
        .toEqual([{ n: 0 }]);
    } finally {
      await admin(`UPDATE organizations SET status = 'active' WHERE id = $1`, [BENE_C]);
    }
    const corr = await call(U_EDIT, OPEN_CORRECTION, [ORG, r.year, r.rev, 'C6 correction']);
    const cs = await importWorkbook(corr.plan_revision_id, 'W13');
    await disposeAll(cs, 'W13');
    await columnsW13(corr.plan_revision_id, cs);
    await linesW13(corr.plan_revision_id, cs);
    await call(U_EDIT, SUBMIT, [corr.plan_revision_id]);
    expect(await call(U_APPROVE, APPROVE, [corr.plan_revision_id])).toMatchObject({ superseded_revision_id: r.rev });
    expect(await rowsAs(U_VIEW, 'SELECT * FROM public.phoenix_central_needs_list_need_lines($1) ORDER BY id', [r.rev])).toEqual(linesBefore);
    const h2 = await recordAt(r.session, 1, 7);
    await refusedClean(r.rev, () => line(r.rev, { bene: BENE_B, item: ITEM_1, qty: '1', sources: [src(h2, '1')] }), { code: '23514', message: 'plan_revision_not_editable' });
    await refusedClean(r.rev, () => admin(`UPDATE central_needs_plan_revisions SET status = 'approved' WHERE id = $1`, [r.rev]),
      { code: '23514', message: 'central_needs_approval_gate_missing', detail: `revision=${r.rev}` });
  });

  // ==========================================================================
  it('N20 role graph: no non-root source (anon, authenticated, service_role, phoenix_demo_purger, every other application or BYPASSRLS role) can SET ROLE, inherit or ADMIN its way into a root, capable or privilege-bearing role, and none is capable itself', async () => {
    // Rig preconditions. Root is a superuser or the database owner ONLY: all 13 Central Needs tables and the whole
    // phoenix_private schema must exist and be root-owned (M218 VERIFY's own ownership rule), so a non-root owner can
    // never be silently exempted — it would be a source, reported SELF ('Central Needs table owner').
    expect((await admin(roleGraph(RG_PRECONDITION)))[0]).toEqual({ cn_tables: 13, cn_not_root: 0, private_schema: 1, private_not_root: 0 });
    const [{ owner, dba }] = await admin(`SELECT pg_get_userbyid(c.relowner) AS owner, pg_get_userbyid(d.datdba) AS dba FROM pg_class c, pg_database d
      WHERE c.oid = 'public.central_needs_plan_revisions'::regclass AND d.datname = current_database()`);
    expect(owner, 'rig precondition: the migration owner is the database owner').toBe(dba);
    // M218's own seal predicate agrees (corroboration, not a substitute: it exempts an object's owner on its own object).
    expect(await admin('SELECT x.breach FROM phoenix_private.central_needs_capability_breaches_v1() AS x(breach)')).toEqual([]);

    // Enumerated from the catalog, never a hand list.
    const sources = await admin<{ source: string; bypassrls: boolean; ident: string }>(roleGraph(RG_SOURCES));
    expect(sources.map((s) => s.source)).toEqual(expect.arrayContaining(['anon', 'authenticated', 'service_role', 'phoenix_demo_purger']));
    expect(sources.find((s) => s.source === 'service_role')!.bypassrls).toBe(true);
    const targets = await admin<{ target: string; ident: string; capable: boolean; why: string }>(roleGraph(RG_TARGETS));
    const target = (name: string) => targets.find((t) => t.target === name)!;
    expect(targets.filter((t) => t.capable).map((t) => t.target)).toEqual(expect.arrayContaining([owner, 'pg_database_owner', 'pg_write_all_data',
      'pg_maintain', 'pg_execute_server_program', 'pg_write_server_files', 'pg_read_server_files']));
    // M218-HC1: read visibility is not a capability — pg_read_all_data (USAGE on every schema, SELECT on every
    // relation, phoenix_private included) is no target at all.
    expect(targets.map((t) => t.target)).not.toContain('pg_read_all_data');
    for (const why of ['superuser', 'database owner', 'Central Needs table owner', 'phoenix_private owner', 'owner of a phoenix_private routine',
      'owner of a routine the Central Needs lifecycle runs', 'owner of a routine a Central Needs or phoenix_private relation depends on']) {
      expect(target(owner).why).toContain(why);
    }
    // IDENTITY targets: the API roles and the demo purger carry privilege surfaces of their own. None is capable.
    for (const name of ['anon', 'authenticated', 'service_role', 'phoenix_demo_purger']) expect(targets.find((t) => t.target === name)?.capable, name).toBe(false);
    expect(target('service_role').why).toContain('BYPASSRLS');
    expect(target('service_role').why).toContain('explicit EXECUTE on a SECURITY DEFINER routine'); // the retained CN writers
    expect(target('phoenix_demo_purger').why).toContain('owner of a SECURITY DEFINER routine');

    // THE ASSERTION: no source is capable itself (effective: direct, PUBLIC, inherited), no membership path of ANY
    // kind — SET, INHERIT, SET then INHERIT, ADMIN, bare membership — leads from a source into any target, and
    // pg_has_role (MEMBER / USAGE / SET / WITH ADMIN OPTION) agrees with the walk for every pair.
    expect(await admin(roleGraph(RG_FINDINGS))).toEqual([]);
    // And the explicit hardening M218 VERIFY D proves at apply time still holds: no explicit grant on the private schema
    // or anything in it, to anyone but its owner (M218-HC1 tolerates only inherited read visibility, never a grant).
    expect(await admin(RG_PRIVATE_ACL)).toEqual([]);

    // Refusal, from each source's OWN session (SET ROLE is checked against the session user): every target refused.
    await rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      try {
        for (const s of sources) {
          for (const t of targets.filter((x) => x.target !== s.source)) {
            const pair = `${s.source} → SET ROLE ${t.target}`;
            await c.query('SAVEPOINT rg');
            await c.query(`SET LOCAL SESSION AUTHORIZATION ${s.ident}`);
            const r = await refusal(c.query(`SET LOCAL ROLE ${t.ident}`)).catch((e: Error) => { throw new Error(`${pair}: ${e.message}`); });
            expect(r, pair).toMatchObject({ code: '42501', message: `permission denied to set role "${t.target}"` });
            await c.query('ROLLBACK TO SAVEPOINT rg');
            await c.query('RELEASE SAVEPOINT rg');
          }
        }
      } finally {
        await c.query('ROLLBACK');
      }
    });

    // The owner's own memberships (bootstrap: the API roles; M141: phoenix_demo_purger) are reached by the probe roles
    // below that inherit the owner; single-hop INHERIT grants keep their expected kind exact.
    const ownerEdges = await admin<{ role: string; inherit: boolean; onward: number }>(`
      SELECT pg_get_userbyid(m.roleid) AS role, m.inherit_option AS inherit,
             (SELECT count(*) FROM pg_auth_members m2 WHERE m2.member = m.roleid)::int AS onward
        FROM pg_auth_members m WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = $1) ORDER BY 1`, [owner]);
    expect(ownerEdges.every((e) => e.inherit && e.onward === 0), JSON.stringify(ownerEdges)).toBe(true);
    const viaOwner = ownerEdges.map((e) => e.role).filter((r) => targets.some((t) => t.target === r));

    // NON-VACUITY, in ONE transaction that is ROLLED BACK: a throwaway probe role per path kind. Each is found with
    // its exact kind and path while every real source stays clean; pg_has_role agrees on every probe pair; and three
    // mutated walks (no implicit datdba edge; SET computed from INHERIT; last-hop ADMIN dropped) are each caught by
    // the cross-check — MEMBER/USAGE, SET and ADMIN columns alike.
    const tag = `c6_rg_${process.pid}_${Date.now().toString(36)}`;
    const p = { set: `${tag}_set`, inh: `${tag}_inh`, mid: `${tag}_mid`, adm: `${tag}_adm`, mem: `${tag}_mem`, mix: `${tag}_mix`,
      hop: `${tag}_hop`, own: `${tag}_own`, svc: `${tag}_svc`, obs: `${tag}_obs`, obsx: `${tag}_obsx`, obsi: `${tag}_obsi`,
      obsw: `${tag}_obsw` };
    for (const point of [RG_IMPLICIT_DBA_EDGE, RG_SET_STEP, RG_LAST_ADMIN]) expect(ROLE_GRAPH.split(point), point).toHaveLength(2);
    const probe = await rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      try {
        await c.query(`SET LOCAL lock_timeout = '30s'`);
        const ownerIdent = (await c.query('SELECT quote_ident($1) AS i', [owner])).rows[0].i as string;
        for (const sql of [
          // (a) SET only: a NOINHERIT role, default grant options (PG16+: INHERIT defaults to rolinherit, SET to true)
          `CREATE ROLE ${p.set} NOLOGIN NOINHERIT`, `GRANT pg_write_all_data TO ${p.set}`,
          // (b) INHERIT only, two hops into the Central Needs owner — and, through datdba, pg_database_owner
          `CREATE ROLE ${p.inh} NOLOGIN`, `CREATE ROLE ${p.mid} NOLOGIN`,
          `GRANT ${p.mid} TO ${p.inh} WITH INHERIT TRUE, SET FALSE`, `GRANT ${ownerIdent} TO ${p.mid} WITH INHERIT TRUE, SET FALSE`,
          // (c) ADMIN only: no privilege and no SET ROLE, but the membership can be granted onward
          `CREATE ROLE ${p.adm} NOLOGIN`, `GRANT pg_maintain TO ${p.adm} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
          // (d) bare membership; (e) SET into a hop that INHERITS a target (pg_has_role USAGE and SET are both false)
          `CREATE ROLE ${p.mem} NOLOGIN`, `GRANT pg_execute_server_program TO ${p.mem} WITH INHERIT FALSE, SET FALSE`,
          `CREATE ROLE ${p.mix} NOLOGIN`, `CREATE ROLE ${p.hop} NOLOGIN`,
          `GRANT ${p.hop} TO ${p.mix} WITH INHERIT FALSE, SET TRUE`, `GRANT pg_write_server_files TO ${p.hop} WITH INHERIT TRUE, SET FALSE`,
          // (f) SET into an IDENTITY target: the owner of a SECURITY DEFINER routine that root-owned code calls
          `CREATE ROLE ${p.own} NOLOGIN`, `GRANT phoenix_demo_purger TO ${p.own} WITH INHERIT FALSE, SET TRUE`,
          // (g) INHERIT into the BYPASSRLS API role that keeps EXECUTE on the retained Central Needs writers
          `CREATE ROLE ${p.svc} NOLOGIN`, `GRANT service_role TO ${p.svc} WITH INHERIT TRUE, SET FALSE`,
          // (h) M218-HC1: a hosted-style read observer — BYPASSRLS, inheriting pg_read_all_data, nothing else: NOT a finding
          `CREATE ROLE ${p.obs} NOLOGIN BYPASSRLS`, `GRANT pg_read_all_data TO ${p.obs}`,
          // (i) M218-HC1: the same observer with a SET-only path into pg_write_all_data: a finding (role escalation)
          `CREATE ROLE ${p.obsx} NOLOGIN BYPASSRLS`, `GRANT pg_read_all_data TO ${p.obsx}`,
          `GRANT pg_write_all_data TO ${p.obsx} WITH INHERIT FALSE, SET TRUE`,
          // (j) M218-HC1: an observer with an INHERIT path into the database owner: a finding (and capable itself)
          `CREATE ROLE ${p.obsi} NOLOGIN BYPASSRLS`, `GRANT pg_read_all_data TO ${p.obsi}`,
          `GRANT ${ownerIdent} TO ${p.obsi} WITH INHERIT TRUE, SET FALSE`,
          // (k) M218-HC1: an observer with an explicit write on the private store: capable itself (explicit + effective)
          `CREATE ROLE ${p.obsw} NOLOGIN BYPASSRLS`, `GRANT pg_read_all_data TO ${p.obsw}`,
          `GRANT UPDATE ON phoenix_private.central_needs_lifecycle_attestations TO ${p.obsw}`,
        ]) await c.query(sql);
        const findings = (await c.query(roleGraph(RG_FINDINGS))).rows;
        // The observer really holds read visibility of the private store (so its absence below is not vacuous).
        const [observer] = (await c.query(`SELECT has_schema_privilege($1::name, 'phoenix_private', 'USAGE') AS private_usage,
          has_table_privilege($1::name, 'phoenix_private.central_needs_lifecycle_attestations', 'SELECT') AS store_select,
          has_table_privilege($1::name, 'phoenix_private.central_needs_lifecycle_attestations', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN') AS store_write`, [p.obs])).rows;
        const noImplicit = (await c.query(roleGraph(RG_CROSSCHECKS, rgMutant(RG_IMPLICIT_DBA_EDGE, 'JOIN role r ON false')))).rows;
        const setFromInherit = (await c.query(roleGraph(RG_CROSSCHECKS, rgMutant(RG_SET_STEP, 'w.all_set AND e.inh,')))).rows;
        const noLastAdmin = (await c.query(roleGraph(RG_CROSSCHECKS, rgMutant(RG_LAST_ADMIN, 'false,')))).rows;
        // Why the walk is needed: the SET-only probe holds no effective privilege, yet CAN become the target; the
        // INHERIT-only probe holds the privileges, yet cannot SET ROLE.
        const [blind] = (await c.query(`SELECT has_table_privilege($1::name, 'public.central_needs_plan_revisions', 'INSERT') AS set_probe,
          has_table_privilege($2::name, 'public.central_needs_plan_revisions', 'INSERT') AS inh_probe`, [p.set, p.inh])).rows;
        await c.query('SAVEPOINT rg');
        await c.query(`SET LOCAL SESSION AUTHORIZATION ${p.set}`);
        await c.query('SET LOCAL ROLE pg_write_all_data');
        const [became] = (await c.query('SELECT session_user::text AS session_user_name, current_user::text AS current_user_name')).rows;
        await c.query('ROLLBACK TO SAVEPOINT rg');
        await c.query(`SET LOCAL SESSION AUTHORIZATION ${p.own}`);
        await c.query('SET LOCAL ROLE phoenix_demo_purger');
        const [becamePurger] = (await c.query('SELECT session_user::text AS session_user_name, current_user::text AS current_user_name')).rows;
        await c.query('ROLLBACK TO SAVEPOINT rg');
        await c.query(`SET LOCAL SESSION AUTHORIZATION ${p.inh}`);
        const inhSet = await refusal(c.query(`SET LOCAL ROLE ${ownerIdent}`));
        await c.query('ROLLBACK TO SAVEPOINT rg');
        await c.query(`SET LOCAL SESSION AUTHORIZATION ${p.svc}`);
        const svcSet = await refusal(c.query('SET LOCAL ROLE service_role'));
        await c.query('ROLLBACK TO SAVEPOINT rg');
        return { findings, observer, noImplicit, setFromInherit, noLastAdmin, blind, became, becamePurger, inhSet, svcSet };
      } finally {
        await c.query('ROLLBACK');
      }
    });
    const kinds = (rows: any[]) => rows.map((r) => `${r.source} → ${r.target}: ${r.kind}`).sort();
    expect(kinds(probe.findings)).toEqual([
      `${p.set} → pg_write_all_data: SET`,
      `${p.inh} → ${owner}: INHERIT`, `${p.inh} → pg_database_owner: INHERIT`, `${p.inh} → ${p.mid}: INHERIT`, `${p.inh} → ${p.inh}: SELF`,
      `${p.mid} → ${owner}: INHERIT`, `${p.mid} → pg_database_owner: INHERIT`, `${p.mid} → ${p.mid}: SELF`,
      ...viaOwner.flatMap((r) => [`${p.inh} → ${r}: INHERIT`, `${p.mid} → ${r}: INHERIT`]),
      `${p.adm} → pg_maintain: ADMIN`,
      `${p.mem} → pg_execute_server_program: MEMBER_ONLY`,
      `${p.mix} → pg_write_server_files: SET_THEN_INHERIT`, `${p.hop} → pg_write_server_files: INHERIT`,
      `${p.own} → phoenix_demo_purger: SET`,
      `${p.svc} → service_role: INHERIT`,
      `${p.obsx} → pg_write_all_data: SET`,
      `${p.obsi} → ${owner}: INHERIT`, `${p.obsi} → pg_database_owner: INHERIT`, `${p.obsi} → ${p.obsi}: SELF`,
      ...viaOwner.map((r) => `${p.obsi} → ${r}: INHERIT`),
      `${p.obsw} → ${p.obsw}: SELF`,
    ].sort());
    // M218-HC1: the pure read observer is tolerated for what it reads — no SELF, no path — although it does read.
    expect(probe.observer).toEqual({ private_usage: true, store_select: true, store_write: false });
    expect(probe.findings.filter((r: any) => r.source === p.obs || r.target === p.obs)).toEqual([]);
    const at = (s: string, t: string) => probe.findings.find((r: any) => r.source === s && r.target === t);
    expect(at(p.obsx, 'pg_write_all_data')).toMatchObject({ path: `${p.obsx} -[.S.]-> pg_write_all_data`, set_reachable: true, inherit_reachable: false });
    expect(at(p.obsi, owner)).toMatchObject({ path: `${p.obsi} -[I..]-> ${owner}`, set_reachable: false, inherit_reachable: true });
    expect(at(p.obsw, p.obsw).why_target).toContain('explicit CREATE, write or EXECUTE grant on phoenix_private or an object in it');
    expect(at(p.obsw, p.obsw).why_target).toContain('effective write on a phoenix_private relation');
    expect(at(p.set, 'pg_write_all_data')).toMatchObject({ path: `${p.set} -[.S.]-> pg_write_all_data`, set_reachable: true, inherit_reachable: false, admin_on_path: false });
    expect(at(p.inh, owner)).toMatchObject({ path: `${p.inh} -[I..]-> ${p.mid} -[I..]-> ${owner}`, set_reachable: false, inherit_reachable: true, admin_on_path: false });
    expect(at(p.inh, 'pg_database_owner').path).toBe(`${p.inh} -[I..]-> ${p.mid} -[I..]-> ${owner} -[IS. implicit]-> pg_database_owner`);
    expect(at(p.adm, 'pg_maintain')).toMatchObject({ path: `${p.adm} -[..A]-> pg_maintain`, set_reachable: false, inherit_reachable: false, admin_on_path: true });
    expect(at(p.mix, 'pg_write_server_files')).toMatchObject({ path: `${p.mix} -[.S.]-> ${p.hop} -[I..]-> pg_write_server_files`, set_reachable: false, inherit_reachable: false });
    expect(at(p.own, 'phoenix_demo_purger')).toMatchObject({ path: `${p.own} -[.S.]-> phoenix_demo_purger`, set_reachable: true, inherit_reachable: false, admin_on_path: false });
    expect(at(p.svc, 'service_role')).toMatchObject({ path: `${p.svc} -[I..]-> service_role`, set_reachable: false, inherit_reachable: true, admin_on_path: false });
    // The cross-check is live on every column.
    expect(kinds(probe.noImplicit)).toEqual([
      `${p.inh} → pg_database_owner: CROSSCHECK pg_has_role(member,usage,set,admin)=t,t,f,f walk=f,f,f,f`,
      `${p.mid} → pg_database_owner: CROSSCHECK pg_has_role(member,usage,set,admin)=t,t,f,f walk=f,f,f,f`,
      `${p.obsi} → pg_database_owner: CROSSCHECK pg_has_role(member,usage,set,admin)=t,t,f,f walk=f,f,f,f`,
    ].sort());
    expect(kinds(probe.setFromInherit)).toEqual(expect.arrayContaining([
      `${p.set} → pg_write_all_data: CROSSCHECK pg_has_role(member,usage,set,admin)=t,f,t,f walk=t,f,f,f`,
      `${p.own} → phoenix_demo_purger: CROSSCHECK pg_has_role(member,usage,set,admin)=t,f,t,f walk=t,f,f,f`,
      `${p.svc} → service_role: CROSSCHECK pg_has_role(member,usage,set,admin)=t,t,f,f walk=t,t,t,f`,
    ]));
    expect(kinds(probe.noLastAdmin)).toEqual([
      `${p.adm} → pg_maintain: CROSSCHECK pg_has_role(member,usage,set,admin)=t,f,f,t walk=t,f,f,f`,
    ]);
    expect(probe.blind).toEqual({ set_probe: false, inh_probe: true });
    expect(probe.became).toEqual({ session_user_name: p.set, current_user_name: 'pg_write_all_data' });
    expect(probe.becamePurger).toEqual({ session_user_name: p.own, current_user_name: 'phoenix_demo_purger' });
    expect(probe.inhSet).toMatchObject({ code: '42501', message: `permission denied to set role "${owner}"` });
    expect(probe.svcSet).toMatchObject({ code: '42501', message: 'permission denied to set role "service_role"' });
    // The rollback left nothing behind in the cluster.
    expect(await admin(`SELECT rolname FROM pg_roles WHERE starts_with(rolname, $1)`, [tag])).toEqual([]);
  });
});
