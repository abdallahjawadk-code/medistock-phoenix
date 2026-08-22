/**
 * AUTHORIZATION-SURFACE — the ONE normalized definition of "the contracted
 * authorization surface", shared by the M194 dynamic proof and the durable
 * H-05 baseline contract test.
 *
 * MODEL: EFFECTIVE privilege, via has_schema_privilege / has_table_privilege /
 * has_sequence_privilege / has_function_privilege — i.e. what a role can
 * actually DO, including privileges reaching it through PUBLIC or through role
 * membership. An `aclexplode`-only model would miss both and is NOT what the
 * verified Production anchors were measured with.
 *
 * FIRST-PARTY: objects in schema `public` that are not extension-owned (no
 * pg_depend deptype='e' edge). pg_trgm and pgcrypto install into `public`, so
 * without this filter their ~68 functions pollute every count.
 *
 * TUPLE FORMAT: `KIND|role|object|privilege`, deterministically sorted, where
 * a function's object is its EXACT identity signature
 * (`proname(pg_get_function_identity_arguments(oid))`).
 *
 * MAINTAIN IS PART OF THE CONTRACT. It is a real PostgreSQL 17 table privilege
 * (VACUUM / ANALYZE / CLUSTER / REINDEX / REFRESH MATERIALIZED VIEW) and it is
 * included in `GRANT ALL ON TABLES`, so the platform's project-provisioning
 * default handed it to `authenticated` on every table created before migration
 * 109. Live Production verification at ceiling 193 measured
 * `authenticated` MAINTAIN relations = 0, while a clean replay carried 68.
 * It is therefore a genuine reproducibility gap, converged by migration 194 —
 * never an ignored privilege, never an exception-listed one.
 */

export const ROLES = ['anon', 'authenticated', 'service_role'] as const;
export const RELATION_PRIVILEGES = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN',
] as const;
export const SEQUENCE_PRIVILEGES = ['USAGE', 'SELECT', 'UPDATE'] as const;
export const SCHEMA_PRIVILEGES = ['USAGE', 'CREATE'] as const;
/** Every relation privilege that is not SELECT — i.e. not a read. */
export const WRITE_PRIVILEGES = [
  'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN',
] as const;

/**
 * Default-ACL grantees the contract compares. `postgres` is deliberately out of
 * scope: it is the object OWNER, it holds every privilege implicitly whether or
 * not an ACL row names it, and its default-ACL rows are owner bookkeeping that
 * materialize as a side effect of REVOKE statements rather than a client-facing
 * authorization decision. PUBLIC ('-') IS compared, because a default grant to
 * PUBLIC is exactly the fail-open regression migration 109 exists to prevent.
 */
export const DEFAULT_ACL_GRANTEES = ['anon', 'authenticated', 'service_role', '-'] as const;

/** The verified Production authenticated direct-write contract. */
export const CONTRACT_WRITE_RELATIONS = ['distribution_points', 'organizations'] as const;

/** The two manual availability writers closed by M194 (H-24). */
export const MANUAL_AVAILABILITY_WRITERS = [
  'phoenix_upsert_availability(uuid,text,text,text,text,integer,text,date,text,text,text,numeric,text)',
  'phoenix_apply_availability_movement(uuid,text,integer,text,text)',
] as const;

const NOT_EXTENSION_OWNED = (classid: string, oid: string): string => `
  NOT EXISTS (SELECT 1 FROM pg_depend d
               WHERE d.classid = '${classid}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`;

const FIRST_PARTY_REL = `
  SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p','f')
     AND ${NOT_EXTENSION_OWNED('pg_class', 'c.oid')}`;

const FIRST_PARTY_SEQ = `
  SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'S'
     AND ${NOT_EXTENSION_OWNED('pg_class', 'c.oid')}`;

const FIRST_PARTY_FN = `
  SELECT p.oid, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS ident
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ${NOT_EXTENSION_OWNED('pg_proc', 'p.oid')}`;

export interface AuthorizationSurface {
  tuples: string[];
  default_acl: string[];
  role_attributes: string[];
  inventory: { functions: string[]; relations: string[]; sequences: string[] };
}

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export async function readAuthorizationSurface(query: Query): Promise<AuthorizationSurface> {
  const rows = async (sql: string, params?: unknown[]) => (await query(sql, params)).rows;

  const schema = await rows(`
    SELECT r.rolname, pr.p AS privilege
      FROM pg_roles r CROSS JOIN (SELECT unnest($2::text[]) AS p) pr
     WHERE r.rolname = ANY($1::text[]) AND has_schema_privilege(r.oid, 'public', pr.p)`,
    [ROLES, SCHEMA_PRIVILEGES]);

  const relation = await rows(`
    WITH rel AS (${FIRST_PARTY_REL})
    SELECT r.rolname, rel.relname AS object, pr.p AS privilege
      FROM pg_roles r CROSS JOIN rel CROSS JOIN (SELECT unnest($2::text[]) AS p) pr
     WHERE r.rolname = ANY($1::text[]) AND has_table_privilege(r.oid, rel.oid, pr.p)`,
    [ROLES, RELATION_PRIVILEGES]);

  const sequence = await rows(`
    WITH s AS (${FIRST_PARTY_SEQ})
    SELECT r.rolname, s.relname AS object, pr.p AS privilege
      FROM pg_roles r CROSS JOIN s CROSS JOIN (SELECT unnest($2::text[]) AS p) pr
     WHERE r.rolname = ANY($1::text[]) AND has_sequence_privilege(r.oid, s.oid, pr.p)`,
    [ROLES, SEQUENCE_PRIVILEGES]);

  const func = await rows(`
    WITH f AS (${FIRST_PARTY_FN})
    SELECT r.rolname, f.ident AS object
      FROM pg_roles r CROSS JOIN f
     WHERE r.rolname = ANY($1::text[]) AND has_function_privilege(r.oid, f.oid, 'EXECUTE')`,
    [ROLES]);

  const defaultAcl = await rows(`
    SELECT pg_get_userbyid(d.defaclrole) AS owner_role,
           COALESCE(n.nspname,'(global)') AS schema,
           CASE d.defaclobjtype WHEN 'r' THEN 'table' WHEN 'S' THEN 'sequence'
                WHEN 'f' THEN 'function' WHEN 'T' THEN 'type' ELSE d.defaclobjtype::text END AS object_type,
           a.grantee::regrole::text AS grantee, a.privilege_type AS privilege
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a
     WHERE (n.nspname = 'public' OR n.nspname IS NULL)
       AND a.grantee::regrole::text = ANY($1::text[])`, [DEFAULT_ACL_GRANTEES]);

  const roleAttrs = await rows(`
    SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
           rolcanlogin, rolreplication, rolbypassrls
      FROM pg_roles WHERE rolname = ANY($1::text[])`, [ROLES]);

  const inventory = {
    functions: (await rows(`WITH f AS (${FIRST_PARTY_FN}) SELECT ident FROM f ORDER BY 1`)).map((r) => r.ident as string),
    relations: (await rows(`WITH r AS (${FIRST_PARTY_REL}) SELECT relname FROM r ORDER BY 1`)).map((r) => r.relname as string),
    sequences: (await rows(`WITH s AS (${FIRST_PARTY_SEQ}) SELECT relname FROM s ORDER BY 1`)).map((r) => r.relname as string),
  };

  return {
    tuples: [
      ...schema.map((r) => `SCHEMA|${r.rolname}|public|${r.privilege}`),
      ...relation.map((r) => `RELATION|${r.rolname}|${r.object}|${r.privilege}`),
      ...sequence.map((r) => `SEQUENCE|${r.rolname}|${r.object}|${r.privilege}`),
      ...func.map((r) => `FUNCTION|${r.rolname}|${r.object}|EXECUTE`),
    ].sort(),
    default_acl: defaultAcl
      .map((r) => `DEFACL|${r.owner_role}|${r.schema}|${r.object_type}|${r.grantee}|${r.privilege}`)
      .sort(),
    role_attributes: roleAttrs
      .map((r) => `ROLE|${r.rolname}|super=${r.rolsuper}|inherit=${r.rolinherit}|createrole=${r.rolcreaterole}` +
                  `|createdb=${r.rolcreatedb}|login=${r.rolcanlogin}|repl=${r.rolreplication}|bypassrls=${r.rolbypassrls}`)
      .sort(),
    inventory,
  };
}

export const tuplesOfKind = (tuples: readonly string[], kind: string, role: string): string[] =>
  tuples.filter((t) => t.startsWith(`${kind}|${role}|`));

export const objectsOf = (tuples: readonly string[]): string[] =>
  [...new Set(tuples.map((t) => t.split('|')[2]))].sort();

export const setDifference = (a: readonly string[], b: readonly string[]): string[] => {
  const B = new Set(b);
  return a.filter((x) => !B.has(x));
};

/** Authenticated direct WRITE tuples, as `relation|PRIVILEGE`. */
export const authenticatedWrites = (tuples: readonly string[]): string[] =>
  tuples
    .filter((t) => t.startsWith('RELATION|authenticated|'))
    .filter((t) => (WRITE_PRIVILEGES as readonly string[]).includes(t.split('|')[3]))
    .map((t) => `${t.split('|')[2]}|${t.split('|')[3]}`)
    .sort();

/** Render a set difference for a failure message — actual tuples, never counts. */
export const renderDiff = (label: string, tuples: readonly string[], limit = 40): string =>
  tuples.length === 0
    ? `${label}: {}`
    : `${label} (${tuples.length}):\n` +
      tuples.slice(0, limit).map((t) => `    ${t}`).join('\n') +
      (tuples.length > limit ? `\n    ... ${tuples.length - limit} more` : '');
