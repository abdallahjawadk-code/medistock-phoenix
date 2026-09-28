/**
 * C6-F1 / M218 FINAL — STATIC guard over the capability-isolated, sealed
 * Central Needs submission architecture.
 *
 * Proves, from the migration text alone, the frozen FINAL shape of M218.
 * Static matching is supplemental; the dynamic PostgreSQL suite is the proof.
 *
 *   * registration and hygiene: the canonical filename, the only file above
 *     217, one BEGIN;/COMMIT;, LF only, M209-M217 byte-identical (git blob
 *     ids; M217 also by SHA-256);
 *   * the activation shape: search_path pinned to pg_catalog, pg_temp first;
 *     the prelude (READ COMMITTED, PostgreSQL 17+, RLS bypass, idempotence,
 *     no adopted phoenix_private, M217, the dependencies, the root-of-trust
 *     applier, the baselines); the timeouts; EXACTLY one NOWAIT lock over the
 *     13 Central Needs tables; the fail-closed SUBMITTED precondition — all
 *     before any CREATE;
 *   * the exact DDL inventory: the private schema, ONE private store, four
 *     private SECURITY INVOKER routines, three public replacements, ONE
 *     trigger, the capability convergence (its exact REVOKE templates, the
 *     three routines service_role keeps, the one default privilege), ONE
 *     partial readiness index (§12) — no
 *     GRANT, no DROP, no business DML;
 *   * every M218 routine's search_path and explicit qualification;
 *   * the digest (the frozen R1 scope), the seal predicate, both fences
 *     (private store only, no re-hash), the approval fence wrapper;
 *   * submit = the M211 body plus exactly the FINAL additions; approve = the
 *     M217 body plus exactly the FINAL additions (no re-hash);
 *   * VERIFY's sections A-I.
 *
 * Structural assertions run against comment-stripped SQL (stripSqlComments);
 * negative assertions run against executable SQL with literals blanked
 * (executableSql), so neither prose nor a RAISE message can satisfy or trip a
 * check.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executableSql, normalizeSql, stripSqlComments } from './helpers/sql-source';

const MIGRATIONS = join(__dirname, '..');
const FILENAME = '218_phoenix_central_needs_submission_integrity_fence.sql';
const PRESENT = existsSync(join(MIGRATIONS, FILENAME));
const SQL = PRESENT ? readFileSync(join(MIGRATIONS, FILENAME), 'utf8') : '';
const CODE = stripSqlComments(SQL);
const EXEC = executableSql(SQL);

const VERIFY_AT = CODE.indexOf('DO $verify$');
const VERIFY = VERIFY_AT >= 0 ? CODE.slice(VERIFY_AT) : '';

const M211 = readFileSync(join(MIGRATIONS, '211_phoenix_central_needs_batch_and_disposition.sql'), 'utf8');
const M217 = readFileSync(join(MIGRATIONS, '217_phoenix_central_needs_c5_safety_convergence.sql'), 'utf8');

const P = 'phoenix_private';
const STORE = `${P}.central_needs_lifecycle_attestations`;
const FENCE = `${P}.central_needs_submission_gate_fence_v1`;
const APPROVAL_BODY = `${P}.central_needs_approval_gate_fence_v1`;
const DIGEST = `${P}.central_needs_submission_state_digest_v1`;
const BREACHES = `${P}.central_needs_capability_breaches_v1`;
const APPROVAL_FENCE = 'public._phoenix_central_needs_approval_gate_fence_v1';
const SUBMIT = 'public.phoenix_central_needs_submit_revision';
const APPROVE = 'public.phoenix_central_needs_approve_revision';
const BLOCKERS = '_phoenix_central_needs_review_blockers_v1';
const TRIGGER = 'central_needs_plan_revisions_c6_submission_gate';
const CONTRACT = 'c6-f1-final-v1';
const PRIVATE_ROUTINES = [DIGEST, BREACHES, FENCE, APPROVAL_BODY] as const;
const CN_TABLES = [
  'central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files', 'central_needs_import_sessions',
  'central_needs_source_records', 'central_needs_record_mappings', 'central_needs_field_overrides', 'central_needs_import_batches',
  'central_needs_import_batch_entries', 'central_needs_beneficiary_column_mappings', 'central_needs_beneficiary_regions',
  'central_needs_need_lines', 'central_needs_need_line_sources',
];
const SVC_KEPT = ['_phoenix_central_needs_payload_digest_v1', 'phoenix_central_needs_apply_authoritative_replay',
  'phoenix_central_needs_register_import_batch'];

const gitBlob = (content: Buffer) =>
  createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])).digest('hex');

/** Whitespace normalized, and no space just inside parentheses: layout-insensitive statement text. */
const tight = (sql: string) => normalizeSql(sql).replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Index of `needle` in `text`, asserted present. */
function at(text: string, needle: string | RegExp, label: string): number {
  const i = typeof needle === 'string' ? text.indexOf(needle) : text.search(needle);
  expect(i, `${label} present`).toBeGreaterThanOrEqual(0);
  return i;
}

/** The comment-stripped source (header through closing dollar quote) of a schema-qualified routine. */
function fnSource(sql: string, qualified: string): string | null {
  const active = stripSqlComments(sql);
  const found = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${esc(qualified)}\\s*\\(`).exec(active);
  if (!found) return null;
  const rest = active.slice(found.index);
  const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
  if (!open) return null;
  const close = rest.indexOf(open[0], open.index + open[0].length);
  return close < 0 ? null : rest.slice(0, close + open[0].length);
}
function fn(qualified: string, sql = SQL): string {
  const src = fnSource(sql, qualified);
  expect(src, `${qualified} is defined`).not.toBeNull();
  return src ?? '';
}
const bodyOf = (src: string) => src.slice(src.indexOf('$$'));
/** Header of a routine: the attribute text between its parameter list and AS. */
function attrs(src: string): string {
  const open = src.indexOf('(');
  let depth = 1;
  let i = open + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '(') depth += 1;
    if (src[i] === ')') depth -= 1;
    i += 1;
  }
  return tight(src.slice(i, i + src.slice(i).search(/\bAS\s+\$/)));
}
function raiseOf(body: string, code: string): string {
  const i = at(body, `'${code}'`, code);
  return body.slice(i, body.indexOf(';', i) + 1);
}
/** Removes one exact (normalized) snippet from `text`, asserting it occurs exactly once. */
function drop(text: string, snippet: string): string {
  const n = normalizeSql(snippet);
  expect(text.split(n), `exactly one: ${n.slice(0, 90)}`).toHaveLength(2);
  return normalizeSql(text.replace(n, ' '));
}
/** Replaces one exact (normalized) snippet in `text`, asserting it occurs exactly once. */
function swap(text: string, from: string, to: string): string {
  const n = normalizeSql(from);
  expect(text.split(n), `exactly one: ${n.slice(0, 90)}`).toHaveLength(2);
  return normalizeSql(text.replace(n, normalizeSql(to)));
}

/** EXEC with every CREATE ... FUNCTION definition removed: what runs AT MIGRATION TIME (DO blocks stay). */
function outsideFunctionBodies(exec: string): string {
  let out = exec;
  for (;;) {
    const m = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+\w+\.\w+\s*\(/.exec(out);
    if (!m) return out;
    const rest = out.slice(m.index);
    const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (!open) return out;
    const close = rest.indexOf(open[0], open.index + open[0].length);
    if (close < 0) return out;
    out = out.slice(0, m.index) + '/*fn*/' + rest.slice(close + open[0].length);
  }
}
/** Top-level statements, with every dollar-quoted body collapsed to `$$`. */
function topLevelStatements(src: string): string[] {
  let flat = '';
  let i = 0;
  while (i < src.length) {
    const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
    if (open) {
      const close = src.indexOf(open[0], i + open[0].length);
      flat += '$$';
      i = close < 0 ? src.length : close + open[0].length;
      continue;
    }
    flat += src[i];
    i += 1;
  }
  return flat.split(';').map((s) => tight(s)).filter((s) => s.length > 0);
}

const guard = PRESENT ? describe : describe.skip;
/** The first DDL CREATE statement (a quoted 'CREATE' privilege name in a query is not one). */
const FIRST_DDL = /\bCREATE\s+(?:SCHEMA|TABLE|FUNCTION|OR\s+REPLACE|TRIGGER)\b/;

describe('C6-F1/M218 static — the file exists under its canonical name', () => {
  it(`${FILENAME} is present`, () => {
    expect(PRESENT, `${FILENAME} is not on disk`).toBe(true);
  });
});

guard('C6-F1/M218 static — registration, hygiene and frozen predecessors', () => {
  it('218 is the next migration after 217; only AUTH-1/M219 sits above it (the ceiling is 219); no timestamp-named migration exists', () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    const files = all.filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files).toContain(FILENAME);
    // AUTH-1/M219 (sign-up authority hardening) is the reviewed successor and
    // now the ceiling; its own static suite owns the ceiling assertions. The
    // 217 -> 218 -> 219 order is exact.
    expect(files.filter((f) => Number(f.slice(0, 3)) > 217))
      .toEqual([FILENAME, '219_phoenix_auth_signup_authority_hardening.sql']);
    expect(Math.max(...files.map((f) => Number(f.slice(0, 3))))).toBe(219);
    expect(files[files.indexOf(FILENAME) - 1]).toBe('217_phoenix_central_needs_c5_safety_convergence.sql');
    expect(all.filter((f) => /^\d{14}_/.test(f))).toEqual([]);
    expect(all.filter((f) => f.includes('submission_integrity_fence'))).toEqual([FILENAME]);
    expect(all.every((f) => /^\d{3}_[A-Za-z0-9_]+\.sql$/.test(f))).toBe(true);
  });

  it('is one explicit transaction: BEGIN; first and COMMIT; last, each exactly once; LF only; no MANUAL APPLY ONLY', () => {
    expect(CODE.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(CODE.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect((SQL.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((SQL.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect((EXEC.match(/\bBEGIN\s*;/g) ?? []).length).toBe(1);
    expect((EXEC.match(/\bCOMMIT\s*;/g) ?? []).length).toBe(1);
    expect(EXEC).not.toMatch(/\bROLLBACK\b/);
    expect(SQL).not.toMatch(/\r/);
    expect(SQL).not.toMatch(/MANUAL APPLY ONLY/i);
  });

  it('leaves M209-M217 byte-identical (git blob ids of the frozen baseline; M217 also by SHA-256)', () => {
    const baseline: Record<string, string> = {
      '209_phoenix_central_needs_registry.sql': '9378bdaf44e6808ac9a0b0abb4ab42c6e283e9e1',
      '210_phoenix_central_needs_workflow_rpcs.sql': 'f61c5206ab843a2bc50dfae972d998700aa9f2bc',
      '211_phoenix_central_needs_batch_and_disposition.sql': '999c6c62154827bd350fea681678a1fa22d74e1e',
      '212_phoenix_central_needs_need_lines.sql': '938a6c7f8a10ff2e89cf5496b46affe43bc1db58',
      '213_phoenix_central_needs_beneficiary_column_mapping.sql': 'a465d323b2cfc9e72e43b9c577163a045c28aa6a',
      '214_phoenix_central_needs_review_readiness_volatility.sql': '2954b3bf349370a6a2701216dc89e3385873601c',
      '215_phoenix_central_needs_governed_correction_lifecycle.sql': '5f1c6bbbb2c2be46c9d7a28642c01e12b76e4c29',
      '216_phoenix_central_needs_region_persistence.sql': 'e87e71effddfc88ede944d52312aca20dbdde391',
      '217_phoenix_central_needs_c5_safety_convergence.sql': 'cf26ee3cfd58b59bd5267ac8e05510fac0d334f8',
    };
    for (const [file, blob] of Object.entries(baseline)) {
      expect(gitBlob(readFileSync(join(MIGRATIONS, file))), file).toBe(blob);
    }
    expect(createHash('sha256').update(readFileSync(join(MIGRATIONS, '217_phoenix_central_needs_c5_safety_convergence.sql'))).digest('hex'))
      .toBe('7ca1fa69aecd9cfefd19fe3fd9555de10eb5edf6fc7ea68d539404549ce5e53a');
  });
});

guard('C6-F1/M218 static — activation shape', () => {
  const STATEMENTS = topLevelStatements(EXEC);

  it('pins search_path to pg_catalog, pg_temp as the FIRST statement after BEGIN — nothing in public can shadow a name the migration resolves', () => {
    expect(STATEMENTS.slice(0, 2)).toEqual(['BEGIN', 'SET LOCAL search_path = pg_catalog, pg_temp']);
  });

  it('the prelude: READ COMMITTED, PostgreSQL 17+, RLS bypass, idempotence, no adopted phoenix_private, M217, the dependencies, the root-of-trust applier, the baselines — in that order, before the timeouts and the one lock', () => {
    const preludeAt = at(CODE, 'DO $prelude$', 'prelude');
    const preludeEnd = CODE.indexOf('$prelude$;', preludeAt);
    const order = [
      "'218_requires_read_committed'", "'218_precondition_failed: PostgreSQL 17 or later is required (the MAINTAIN privilege)'",
      "'218_precondition_failed: the applying role must bypass row-level security'", "'218_already_applied'",
      "'218_precondition_failed: schema phoenix_private already exists'", "'218_precondition_failed: M217 (the approval gate) is not applied'",
      "'public._phoenix_central_needs_payload_digest_v1(jsonb)'",
      "'218_precondition_failed: M218 must be applied by the owner of the Central Needs tables'",
      "'218_precondition_failed: the applying role must own schema public (directly or through pg_database_owner)'",
      "'phoenix_m218.untouched_acl'", "'phoenix_m218.untouched_functions'",
    ].map((n) => at(CODE, n, n));
    for (const [k, i] of order.entries()) {
      expect(i, `prelude step ${k}`).toBeGreaterThan(preludeAt);
      expect(i, `prelude step ${k}`).toBeLessThan(preludeEnd);
      if (k > 0) expect(i, `prelude step ${k}`).toBeGreaterThan(order[k - 1]);
    }
    const lockTimeout = at(CODE, /SET\s+LOCAL\s+lock_timeout\s*=\s*'250ms'\s*;/i, 'lock_timeout');
    const stmtTimeout = at(CODE, /SET\s+LOCAL\s+statement_timeout\s*=\s*'60s'\s*;/i, 'statement_timeout');
    const lock = at(CODE, 'LOCK TABLE public.central_needs_plans,', 'the activation lock');
    expect(preludeEnd).toBeLessThan(lockTimeout);
    expect(lockTimeout).toBeLessThan(stmtTimeout);
    expect(stmtTimeout).toBeLessThan(lock);
    expect(lock).toBeLessThan(at(CODE, FIRST_DDL, 'first CREATE'));
    // The applier: the owner of EVERY Central Needs table, and a member of schema public's owner unless superuser.
    const block = tight(CODE.slice(preludeAt, preludeEnd));
    expect(block).toContain(`WHERE c.oid IN (${CN_TABLES.map((t) => `'public.${t}'::regclass`).join(', ')}) AND c.relowner <> v_me`);
    expect(block).toContain("IF NOT v_super AND NOT pg_has_role(v_me, (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'), 'MEMBER') THEN");
    expect(block).toContain("IF current_setting('server_version_num')::integer < 170000 THEN");
    expect(executableSql(CODE.slice(preludeAt, preludeEnd))).not.toMatch(/\bFROM\s+public\./i);
  });

  it('takes exactly ONE explicit relation lock — the 13 Central Needs tables EXCLUSIVE NOWAIT — and sets only the three LOCAL settings', () => {
    const locks = [...EXEC.matchAll(/\bLOCK\s+(?:TABLE\s+)?[^;]*;/gi)].map((m) => normalizeSql(m[0]));
    expect(locks).toEqual([normalizeSql(`LOCK TABLE ${CN_TABLES.map((t) => `public.${t}`).join(', ')} IN EXCLUSIVE MODE NOWAIT;`)]);
    expect(EXEC.match(/SET\s+LOCAL\s+\w+/gi)?.map((s) => normalizeSql(s)))
      .toEqual(['SET LOCAL search_path', 'SET LOCAL lock_timeout', 'SET LOCAL statement_timeout']);
    expect(EXEC).not.toMatch(/\bSET\s+(?:SESSION\s+)?(?:TRANSACTION|CHARACTERISTICS)\b/i);
  });

  it('refuses while any revision is SUBMITTED (a plain SELECT under the lock) — never synthesizing, backdating or inferring an attestation', () => {
    const lock = at(CODE, 'LOCK TABLE public.central_needs_plans,', 'lock');
    const pre = at(CODE, 'DO $precondition$', 'precondition');
    const preEnd = CODE.indexOf('$precondition$;', pre);
    expect(pre).toBeGreaterThan(lock);
    expect(preEnd).toBeLessThan(at(CODE, FIRST_DDL, 'first CREATE'));
    const block = CODE.slice(pre, preEnd);
    expect(block).toMatch(/status\s*=\s*'submitted'/);
    expect(tight(raiseOf(block, '218_precondition_failed'))).toMatch(
      /^'218_precondition_failed' USING DETAIL = format\('submitted=%s with_submit_audit=%s without_submit_audit=%s',/);
    expect(executableSql(block)).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i);
    expect(block).not.toContain('central_needs_lifecycle_attestations');
  });

  it('holds no advisory lock and no row lock outside a routine body, and waits on nothing', () => {
    const outside = outsideFunctionBodies(EXEC);
    expect(EXEC).not.toMatch(/pg_advisory/i);
    expect(outside).not.toMatch(/\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/i);
    expect(outside).not.toMatch(/\bFOR\s+(?:KEY\s+)?SHARE\b/i);
    expect(outside).not.toMatch(/\bpg_sleep\b/i);
  });
});

guard('C6-F1/M218 static — exact DDL inventory', () => {
  const STATEMENTS = topLevelStatements(EXEC);
  const OUTSIDE = outsideFunctionBodies(EXEC);

  it('every top-level statement is of an allowed kind, with exact counts', () => {
    const kinds = STATEMENTS.map((s) => {
      const k = /^(BEGIN|COMMIT|DO|SET LOCAL|LOCK TABLE|CREATE SCHEMA|CREATE TABLE|ALTER TABLE|CREATE FUNCTION|CREATE OR REPLACE FUNCTION|CREATE TRIGGER|CREATE INDEX|REVOKE|ALTER DEFAULT PRIVILEGES|COMMENT ON (?:SCHEMA|FUNCTION|TRIGGER|TABLE|INDEX))\b/.exec(s);
      return k ? k[1] : `UNEXPECTED: ${s.slice(0, 80)}`;
    });
    expect(kinds.filter((k) => k.startsWith('UNEXPECTED'))).toEqual([]);
    const count = (k: string) => kinds.filter((x) => x === k).length;
    expect({
      BEGIN: count('BEGIN'), COMMIT: count('COMMIT'), DO: count('DO'), SET: count('SET LOCAL'), LOCK: count('LOCK TABLE'),
      SCHEMA: count('CREATE SCHEMA'), TABLE: count('CREATE TABLE'), ALTER: count('ALTER TABLE'), CREATE_FN: count('CREATE FUNCTION'),
      REPLACE_FN: count('CREATE OR REPLACE FUNCTION'), TRIGGER: count('CREATE TRIGGER'), REVOKE: count('REVOKE'),
      DEFAULTS: count('ALTER DEFAULT PRIVILEGES'), C_SCHEMA: count('COMMENT ON SCHEMA'), C_FN: count('COMMENT ON FUNCTION'),
      C_TRIGGER: count('COMMENT ON TRIGGER'), C_TABLE: count('COMMENT ON TABLE'), INDEX: count('CREATE INDEX'),
      C_INDEX: count('COMMENT ON INDEX'),
    }).toEqual({
      BEGIN: 1, COMMIT: 1, DO: 4, SET: 3, LOCK: 1, SCHEMA: 1, TABLE: 1, ALTER: 2, CREATE_FN: 4, REPLACE_FN: 3, TRIGGER: 1,
      REVOKE: 7, DEFAULTS: 1, C_SCHEMA: 1, C_FN: 7, C_TRIGGER: 1, C_TABLE: 1, INDEX: 1, C_INDEX: 1,
    });
    expect(STATEMENTS.filter((s) => s.startsWith('DO')).map((s) => s.slice(0, 16))).toEqual(
      ['DO $$', 'DO $$', 'DO $$', 'DO $$']);
  });

  it('the routines: four NEW private ones (created, never replaced) and exactly three public replacements; nothing else', () => {
    const created = [...CODE.matchAll(/CREATE\s+FUNCTION\s+(\w+\.\w+)\s*\(/g)].map((m) => m[1]).sort();
    expect(created).toEqual([...PRIVATE_ROUTINES].sort());
    const replaced = [...CODE.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(\w+\.\w+)\s*\(/g)].map((m) => m[1]).sort();
    expect(replaced).toEqual([APPROVAL_FENCE, APPROVE, SUBMIT].sort());
    expect(CODE).not.toMatch(/FUNCTION\s+public\._phoenix_central_needs_submission_(?:state_digest|gate_fence)_v1/);
  });

  it('the private schema and ONE store: owner-created, everything revoked from PUBLIC, anon, authenticated, service_role; RLS enabled AND forced; the frozen shape and contract', () => {
    expect(STATEMENTS).toContain(`CREATE SCHEMA ${P}`);
    expect(STATEMENTS).toContain(`REVOKE ALL ON SCHEMA ${P} FROM PUBLIC, anon, authenticated, service_role`);
    expect(STATEMENTS).toContain(`REVOKE ALL ON TABLE ${STORE} FROM PUBLIC, anon, authenticated, service_role`);
    expect(STATEMENTS.filter((s) => s.startsWith('ALTER TABLE'))).toEqual([
      `ALTER TABLE ${STORE} ENABLE ROW LEVEL SECURITY`, `ALTER TABLE ${STORE} FORCE ROW LEVEL SECURITY`,
    ]);
    expect(tight(CODE)).toContain(tight(`CREATE TABLE ${STORE} (
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
      CONSTRAINT central_needs_lifecycle_attestations_contract_chk CHECK (contract = '${CONTRACT}'),
      CONSTRAINT central_needs_lifecycle_attestations_txid_chk CHECK (txid > 0),
      CONSTRAINT central_needs_lifecycle_attestations_digest_chk CHECK (state_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT central_needs_lifecycle_attestations_once_key UNIQUE (plan_revision_id, phase, txid),
      CONSTRAINT central_needs_lifecycle_attestations_revision_org_fk
        FOREIGN KEY (plan_revision_id, organization_id)
        REFERENCES public.central_needs_plan_revisions (id, organization_id) ON DELETE RESTRICT
    );`));
    expect(EXEC).not.toMatch(/\b(?:SERIAL|BIGSERIAL|SMALLSERIAL|GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY|nextval)\b/i);
    expect(EXEC).not.toMatch(/\bCREATE\s+POLICY\b|\bALTER\s+POLICY\b/i);
  });

  it('exactly ONE index (§12): the partial readiness index over the readiness predicate\'s own expression, built after the activation lock', () => {
    expect(STATEMENTS.filter((s) => s.startsWith('CREATE INDEX'))).toEqual([
      "CREATE INDEX central_needs_source_records_invalid_evidence_idx ON public.central_needs_source_records (import_session_id) WHERE public._phoenix_central_needs_review_numeric_class_v1(source_values) = ''",
    ]);
    expect(tight(CODE)).toContain("WHERE public._phoenix_central_needs_review_numeric_class_v1(source_values) = 'invalid_evidence';");
    expect(at(CODE, 'CREATE INDEX central_needs_source_records_invalid_evidence_idx', 'index'))
      .toBeGreaterThan(at(CODE, 'LOCK TABLE public.central_needs_plans,', 'lock'));
    // The index serves the M217 readiness branch verbatim: the same expression and constant.
    expect(tight(M217)).toContain("AND public._phoenix_central_needs_review_numeric_class_v1(r.source_values) = 'invalid_evidence'");
  });

  it('exactly ONE trigger: the private submission fence, BEFORE UPDATE on plan_revisions, no column list, FOR EACH ROW', () => {
    expect(STATEMENTS.filter((s) => /^CREATE (?:CONSTRAINT )?TRIGGER\b/.test(s))).toEqual([
      `CREATE TRIGGER ${TRIGGER} BEFORE UPDATE ON public.central_needs_plan_revisions FOR EACH ROW EXECUTE FUNCTION ${FENCE}()`,
    ]);
    expect(OUTSIDE).not.toMatch(/\bUPDATE\s+OF\b/i);
  });

  it('no GRANT anywhere, no DROP, no ownership change, no trigger disabling, no replication-role switch, no index/view/type/sequence/extension, no ALTER FUNCTION', () => {
    for (const forbidden of [
      /\bGRANT\b/i, /\bDROP\b/i, /\bOWNER\s+TO\b/i, /\bVALIDATE\s+CONSTRAINT\b/i, /\bDISABLE\s+TRIGGER\b/i,
      /\bENABLE\s+(?:ALWAYS|REPLICA)\s+TRIGGER\b/i, /session_replication_role/i, /\bCREATE\s+UNIQUE\s+INDEX\b/i, /\bCONCURRENTLY\b/i,
      /\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i, /\bCREATE\s+TYPE\b/i, /\bCREATE\s+SEQUENCE\b/i, /\bCREATE\s+EXTENSION\b/i,
      /\bALTER\s+FUNCTION\b/i, /\bALTER\s+ROLE\b/i, /\bALTER\s+DATABASE\b/i, /\bADD\s+(?:COLUMN|CONSTRAINT)\b/i,
      /\bCOMMENT\s+ON\s+COLUMN\b/i, /\bSECURITY\s+LABEL\b/i,
    ]) {
      expect(EXEC, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('writes no business row at migration time (DML appears only inside routine bodies and the rolled-back VERIFY probe)', () => {
    const migrationTime = OUTSIDE.slice(0, OUTSIDE.indexOf('DO $verify$'))
      .split(';').filter((stmt) => !/^\s*REVOKE\b/i.test(stmt)).join(';');
    expect(migrationTime).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(migrationTime).not.toMatch(/\bUPDATE\s+(?:ONLY\s+)?(?:\w+\.)?\w+\s+SET\b/i);
    expect(migrationTime).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bCOPY\b|\bMERGE\s+INTO\b/i);
    expect(executableSql(VERIFY)).not.toMatch(/\b(?:INSERT|DELETE|TRUNCATE|MERGE)\b|\bUPDATE\s+\w+\s+SET\b/i);
  });

  it('set_config names only M218\'s own phoenix_m218.* baselines', () => {
    const names = [...CODE.matchAll(/\bset_config\s*\(\s*([^,]*),/gi)].map((m) => m[1].trim());
    expect(names).toEqual(["'phoenix_m218.untouched_acl'", "'phoenix_m218.untouched_functions'", "'phoenix_m218.revision_status'"]);
  });
});

guard('C6-F1/M218 static — capability convergence (§2, §3, §13)', () => {
  const STATEMENTS = topLevelStatements(EXEC);
  const CONVERGE_AT = CODE.indexOf('DO $converge$');
  const CONVERGE = CODE.slice(CONVERGE_AT, CODE.indexOf('$converge$;', CONVERGE_AT));

  it('service_role loses every Central Needs write, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on exactly the 13 tables — and keeps SELECT', () => {
    expect(STATEMENTS).toContain(
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE ${CN_TABLES.map((t) => `public.${t}`).join(', ')} FROM service_role CASCADE`);
    const revokes = STATEMENTS.filter((s) => s.startsWith('REVOKE'));
    expect(revokes.filter((s) => /\bSELECT\b/.test(s))).toEqual([]);
    expect(revokes.map((s) => s.replace(/ ON .*/, ''))).toEqual([
      'REVOKE ALL', 'REVOKE ALL', 'REVOKE ALL', 'REVOKE ALL', 'REVOKE ALL', 'REVOKE ALL',
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN',
    ]);
  });

  it('the only dynamic SQL is the convergence: exactly three REVOKE templates (TRIGGER on public relations, CREATE on public, EXECUTE on the Central Needs SECURITY DEFINER surface), each CASCADE', () => {
    const templates = [...CODE.matchAll(/\bEXECUTE\s+format\s*\(\s*'([^']*)'/g)].map((m) => m[1]);
    expect(templates).toEqual([
      'REVOKE TRIGGER ON TABLE %s FROM %s CASCADE',
      'REVOKE CREATE ON SCHEMA public FROM %s CASCADE',
      'REVOKE EXECUTE ON ROUTINE %s FROM service_role CASCADE',
    ]);
    const rest = EXEC.replace(/\bFOR\s+EACH\s+ROW\s+EXECUTE\s+FUNCTION\b/gi, '');
    expect((rest.match(/\bEXECUTE\b/gi) ?? []).length).toBe(3);
    expect(CODE.slice(0, CONVERGE_AT)).not.toMatch(/\bEXECUTE\s+format\b/);
    expect(EXEC).not.toMatch(/\bdblink\w*\s*\(/i);
  });

  it('the non-root grantee predicate spares only true superusers, the database owner, predefined pg_* roles and each object\'s owner; service_role keeps EXECUTE on exactly the three trusted routines', () => {
    const t = tight(CONVERGE);
    const nonRoot = "(a.grantee = 0 OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.oid = a.grantee AND NOT x.rolsuper AND x.rolname !~ '^pg_' AND x.oid <> (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = current_database())))";
    expect(t.split(nonRoot)).toHaveLength(3);
    expect(t).toContain("c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.privilege_type = 'TRIGGER' AND a.grantee <> c.relowner");
    expect(t).toContain("a.privilege_type = 'CREATE' AND a.grantee <> n.nspowner");
    expect(t).toContain(`AND p.proname LIKE '%central\\_needs\\_%' AND p.prosecdef AND p.proname NOT IN (${SVC_KEPT.map((k) => `'${k}'`).join(', ')})`);
  });

  it('the one default privilege changed: future public tables of the migration owner no longer grant service_role TRIGGER — the DML, sequence and function defaults are untouched', () => {
    expect(STATEMENTS.filter((s) => s.startsWith('ALTER DEFAULT PRIVILEGES'))).toEqual([
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRIGGER ON TABLES FROM service_role',
    ]);
    expect(at(CODE, 'ALTER DEFAULT PRIVILEGES', 'defaults')).toBeGreaterThan(CONVERGE_AT);
    expect(at(CODE, 'ALTER DEFAULT PRIVILEGES', 'defaults')).toBeLessThan(VERIFY_AT);
  });

  it('the convergence runs after every routine and the trigger exist, and before VERIFY', () => {
    expect(CONVERGE_AT).toBeGreaterThan(at(CODE, `CREATE TRIGGER ${TRIGGER}`, 'trigger'));
    expect(CONVERGE_AT).toBeGreaterThan(at(CODE, `CREATE OR REPLACE FUNCTION ${APPROVE}(`, 'approve'));
    expect(CONVERGE_AT).toBeLessThan(VERIFY_AT);
  });
});

guard('C6-F1/M218 static — search paths and explicit qualification (§5)', () => {
  it('the four private routines are SECURITY INVOKER with search_path pg_catalog, pg_temp; each is revoked from PUBLIC, anon, authenticated and service_role', () => {
    const statements = topLevelStatements(CODE);
    for (const name of PRIVATE_ROUTINES) {
      const a = attrs(fn(name));
      expect(a, name).toMatch(/\bSECURITY INVOKER SET search_path = pg_catalog, pg_temp$/);
      expect(a, name).not.toMatch(/SECURITY DEFINER/);
      expect(statements.filter((s) => s.startsWith(`REVOKE ALL ON FUNCTION ${name}(`)), name).toHaveLength(1);
      expect(statements.find((s) => s.startsWith(`REVOKE ALL ON FUNCTION ${name}(`)), name).toMatch(/FROM PUBLIC, anon, authenticated, service_role$/);
    }
    expect(attrs(fn(DIGEST))).toBe('RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp');
    expect(attrs(fn(BREACHES))).toBe('RETURNS SETOF text LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp');
  });

  it('submit and approve are SECURITY DEFINER with search_path pg_catalog, pg_temp; only submit carries a function-level statement_timeout (at most 60s)', () => {
    const s = attrs(fn(SUBMIT));
    expect(s).toMatch(/^RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET statement_timeout = '(\d+)s'$/);
    expect(Number(/statement_timeout = '(\d+)s'/.exec(s)![1])).toBeLessThanOrEqual(60);
    expect(attrs(fn(APPROVE))).toBe('RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp');
    expect((CODE.match(/SET\s+statement_timeout\s*=/g) ?? []).length).toBe(1);
    expect(CODE).not.toMatch(/ALTER\s+(?:ROLE|DATABASE)[^;]*statement_timeout/i);
  });

  it('M217\'s approval fence keeps its exact C5-pinned header and only delegates to the private body with qualified names', () => {
    expect(attrs(fn(APPROVAL_FENCE))).toBe(attrs(fn(APPROVAL_FENCE, M217)));
    expect(attrs(fn(APPROVAL_FENCE))).toBe('RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp');
    expect(tight(bodyOf(fn(APPROVAL_FENCE)))).toBe(tight(`$$
      BEGIN
        PERFORM ${APPROVAL_BODY}(TG_OP, OLD, NEW);
        RETURN NEW;
      END;
      $$`));
  });

  it('no M218 routine names an application relation without its schema', () => {
    for (const name of [...PRIVATE_ROUTINES, SUBMIT, APPROVE, APPROVAL_FENCE]) {
      const body = executableSql(bodyOf(fn(name)));
      expect(body, name).not.toMatch(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:ONLY\s+)?"?(?:central_needs_|audit_logs\b|organizations\b|warehouses\b|profiles\b|phoenix_(?!private\.))/i);
    }
  });
});

guard('C6-F1/M218 static — the submission-state digest (§8)', () => {
  const BODY = bodyOf(fn(DIGEST));

  it('is one SQL statement: sha256 over the UTF-8 of one jsonb value, 64 hex — no pgcrypto, no md5, nothing volatile, no audit_logs, no readiness call', () => {
    expect(tight(BODY)).toContain(tight(`SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(jsonb_build_array(
      'c6-f1-r1-state-v1',`));
    expect(tight(BODY)).toContain(tight(`)::text, 'UTF8')), 'hex')`));
    const exec = executableSql(BODY);
    expect(exec).not.toMatch(/\b(?:digest|md5|to_jsonb|row_to_json|now|clock_timestamp|statement_timestamp|random|gen_random_uuid|current_setting|txid_current)\s*\(/i);
    expect(exec).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|PERFORM|EXECUTE)\b/i);
    expect(BODY).not.toContain('audit_logs');
    expect(BODY).not.toContain(BLOCKERS);
  });

  it('serializes the frozen scope as tagged sections in a fixed order, each row an explicit positional column list ordered by its uuid key', () => {
    const tags = [...BODY.matchAll(/jsonb_build_array\('(\w+)', \(SELECT/g)].map((m) => m[1]);
    expect(tags).toEqual(['revision', 'sessions', 'files', 'records', 'mappings', 'overrides', 'batches', 'entries', 'columns',
      'regions', 'need_lines', 'links']);
    const sections = [...tight(BODY).matchAll(/jsonb_agg\(jsonb_build_array\(([^]*?)\) ORDER BY (\w+\.\w+)\)/g)]
      .map((m) => ({ cols: m[1].split(/,\s*/), order: m[2] }));
    expect(sections.map((s) => s.order)).toEqual(['ses.id', 'fil.id', 'rec.id', 'map.id', 'ovr.id', 'bat.id', 'ent.id', 'col.id',
      'reg.version_id', 'lin.id', 'lnk.id']);
    expect(sections.map((s) => s.cols)).toEqual([
      ['ses.id', 'ses.source_file_id', 'ses.status', 'ses.preview_digest', 'ses.authoritative_digest', 'ses.parser_identity::text', 'ses.entry_path'],
      ['fil.id', 'fil.file_hash'],
      ['rec.id', 'rec.import_session_id', 'rec.record_ordinal', 'rec.target_entity', 'rec.field_name', 'rec.source_values::text',
        'rec.source_provenance::text'],
      ['map.id', 'map.import_session_id', 'map.target_entity', 'map.decision', 'map.central_item_id', 'map.decision_reason'],
      ['ovr.id', 'ovr.plan_revision_id', 'ovr.source_record_id', 'ovr.target_entity', 'ovr.field_name', 'ovr.previous_value::text',
        'ovr.final_value::text', 'ovr.override_reason', 'ovr.override_note', 'ovr.override_reference',
        "CASE WHEN isfinite(ovr.created_at) THEN to_char(ovr.created_at AT TIME ZONE 'UTC'",
        `'YYYY-MM-DD"T"HH24:MI:SS.US BC') ELSE ovr.created_at::text END`],
      ['bat.id', 'bat.container_kind', 'bat.container_sha256', 'bat.accepted_entry_count', 'bat.excluded_entry_count',
        'bat.reconciliation::text', 'bat.parser_identity::text'],
      ['ent.id', 'ent.batch_id', 'ent.import_session_id', 'ent.entry_ordinal', 'ent.archive_entry_path', 'ent.entry_sha256'],
      ['col.id', 'col.import_session_id', 'col.sheet_index', 'col.column_index', 'col.decision', 'col.beneficiary_organization_id',
        'col.source_field_name', 'col.mapping_reason'],
      ['reg.version_id', 'reg.region_id', 'reg.version_no', 'reg.supersedes_version_id', 'reg.import_session_id', 'reg.sheet_index',
        'reg.row_start', 'reg.row_end', 'reg.column_start', 'reg.column_end', 'reg.decision', 'reg.beneficiary_organization_id',
        'reg.decision_reason', 'reg.retired_at IS NOT NULL', 'reg.retirement_kind'],
      ['lin.id', 'lin.beneficiary_organization_id', 'lin.target_warehouse_id', 'lin.central_item_id', 'lin.approved_quantity',
        'lin.approved_unit', 'lin.unit_conversion_state', 'lin.source_unit_text', 'lin.mapping_reason'],
      ['lnk.id', 'lnk.need_line_id', 'lnk.source_record_id', 'lnk.designated_quantity', 'lnk.applied_override_id'],
    ]);
    expect(tight(BODY)).toContain(
      "jsonb_build_array('revision', (SELECT jsonb_build_array(rev.id, rev.plan_id, rev.organization_id, rev.revision_number) FROM rev))");
    for (const volatile of ['updated_at', 'decided_at', 'linked_at', 'mapped_at', 'started_at', 'completed_at', 'registered_at',
      'uploaded_at', 'mapped_by', 'decided_by', 'linked_by', 'created_by', 'actor_id', 'registered_by', 'retired_by', 'uploaded_by']) {
      expect(BODY, volatile).not.toContain(volatile);
    }
    expect((tight(BODY).match(/COALESCE\(jsonb_agg\(/g) ?? []).length).toBe(11);
    expect((tight(BODY).match(/, '\[\]'::jsonb\) FROM \w+\)\)/g) ?? []).length).toBe(11);
  });

  it('scopes rows by the keys readiness itself uses (revision, sessions, linked records, applied overrides) — each multi-path scope an index-driven UNION', () => {
    const t = tight(BODY);
    for (const scope of [
      'FROM public.central_needs_import_sessions s WHERE s.plan_revision_id = p_plan_revision_id',
      'FROM public.central_needs_need_lines n WHERE n.plan_revision_id = p_plan_revision_id',
      'WHERE l.id IN (SELECT l1.id FROM public.central_needs_need_line_sources l1 WHERE l1.need_line_id IN (SELECT lin.id FROM lin) UNION SELECT l2.id FROM public.central_needs_need_line_sources l2 WHERE l2.source_record_id IN (SELECT sr.id FROM public.central_needs_source_records sr WHERE sr.import_session_id IN (SELECT ses.id FROM ses)))',
      'WHERE sr.id IN (SELECT r1.id FROM public.central_needs_source_records r1 WHERE r1.import_session_id IN (SELECT ses.id FROM ses) UNION SELECT lnk.source_record_id FROM lnk)',
      'WHERE m.import_session_id IN (SELECT rec.import_session_id FROM rec UNION SELECT ses.id FROM ses)',
      'WHERE o.id IN (SELECT o1.id FROM public.central_needs_field_overrides o1 WHERE o1.plan_revision_id = p_plan_revision_id UNION SELECT o2.id FROM public.central_needs_field_overrides o2 WHERE o2.source_record_id IN (SELECT lnk.source_record_id FROM lnk) UNION SELECT lnk.applied_override_id FROM lnk WHERE lnk.applied_override_id IS NOT NULL)',
      'FROM public.central_needs_import_batches b WHERE b.plan_revision_id = p_plan_revision_id',
      'WHERE e.id IN (SELECT e1.id FROM public.central_needs_import_batch_entries e1 WHERE e1.batch_id IN (SELECT bat.id FROM bat) UNION SELECT e2.id FROM public.central_needs_import_batch_entries e2 WHERE e2.import_session_id IN (SELECT ses.id FROM ses))',
      'WHERE c.id IN (SELECT c1.id FROM public.central_needs_beneficiary_column_mappings c1 WHERE c1.plan_revision_id = p_plan_revision_id UNION SELECT c2.id FROM public.central_needs_beneficiary_column_mappings c2 WHERE c2.import_session_id IN (SELECT ses.id FROM ses))',
      'WHERE g.version_id IN (SELECT g1.version_id FROM public.central_needs_beneficiary_regions g1 WHERE g1.plan_revision_id = p_plan_revision_id UNION SELECT g2.version_id FROM public.central_needs_beneficiary_regions g2 WHERE g2.import_session_id IN (SELECT ses.id FROM ses))',
      'FROM public.central_needs_source_files f WHERE f.id IN (SELECT ses.source_file_id FROM ses)',
      'FROM public.central_needs_plan_revisions r WHERE r.id = p_plan_revision_id',
    ]) {
      expect(t, scope).toContain(scope);
    }
    expect(t).toContain('SELECT r.id, r.plan_id, r.organization_id, r.revision_number FROM public.central_needs_plan_revisions r');
    expect(BODY).not.toMatch(/\br\.status\b/);
    expect(executableSql(BODY)).not.toMatch(/\bOR\b/i);
  });
});

guard('C6-F1/M218 static — the seal predicate (§7, §9.4)', () => {
  const T = tight(bodyOf(fn(BREACHES)));

  it('non-root = not a true superuser, not a predefined pg_* role, not the database owner; each object\'s owner is exempt on its own object', () => {
    expect(T).toContain("nonroot AS (SELECT r.oid, r.rolname FROM pg_catalog.pg_roles r WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid <> (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()))");
    expect(T).toContain(`WHERE (n.nspname = 'public' AND c.relname IN (${CN_TABLES.map((t) => `'${t}'`).join(', ')})) OR (n.nspname = 'phoenix_private' AND c.relname = 'central_needs_lifecycle_attestations')`);
    expect(T).toContain("(VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) AS p(priv) WHERE u.oid <> cn.relowner AND pg_catalog.has_table_privilege(u.oid, cn.oid, p.priv)");
    expect(T).toContain("(VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(priv) WHERE u.oid <> cn.relowner AND NOT pg_catalog.has_table_privilege(u.oid, cn.oid, p.priv) AND pg_catalog.has_any_column_privilege(u.oid, cn.oid, p.priv)");
    expect(T).toContain("WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND u.oid <> c.relowner AND pg_catalog.has_table_privilege(u.oid, c.oid, 'TRIGGER')");
    expect(T).toContain("CROSS JOIN (VALUES ('CREATE')) AS p(priv) WHERE u.oid <> s.nspowner AND pg_catalog.has_schema_privilege(u.oid, s.oid, p.priv)");
    expect(T).toContain("WHERE r.rolname IN ('anon', 'authenticated', 'service_role')");
    expect(T).toContain("WHERE n.nspname IN ('public', 'phoenix_private')");
  });

  it('M218-HC1: a MUTATION-capability seal — no read privilege (USAGE, SELECT) is ever a breach, and tolerance is by capability, never by a hosted role name', () => {
    // Literals are what this checks, so the body is comment-stripped but NOT literal-blanked (executableSql would
    // blank them). The EXACT literal inventory: every privilege named is a mutation, code-injection or ownership
    // capability (no USAGE / SELECT in any case or combination), and the only role names are the API roles of the
    // ownership branch (d) — non-root is defined by attributes, never by a hosted role name.
    const code = stripSqlComments(bodyOf(fn(BREACHES)));
    expect(code).toContain("(VALUES ('CREATE')) AS p(priv)");
    const literals = [...new Set([...code.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]))].sort();
    expect(literals).toEqual([
      '%s holds %s on %I.%I', '%s holds %s on schema %I', '%s holds TRIGGER on public.%I', '%s holds a column-level %s on %I.%I',
      '%s owns %s %I.%I',
      'CREATE', 'DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'TRIGGER', 'TRUNCATE', 'UPDATE',
      '^pg_', 'anon', 'authenticated', ...CN_TABLES, 'central_needs_lifecycle_attestations',
      'f', 'm', 'operator', 'p', 'phoenix_private', 'public', 'r', 'relation', 'routine', 'service_role', 'type', 'v',
    ].sort());
  });
});

guard('C6-F1/M218 static — the fences consume ONLY the private store and never re-hash', () => {
  const PREDICATE = (row: 'NEW' | 'p_new', phase: 'submit' | 'approve') => [
    `a.plan_revision_id = ${row}.id`, `a.organization_id = ${row}.organization_id`, `a.phase = '${phase}'`,
    `a.contract = '${CONTRACT}'`, 'a.actor_id = auth.uid()', 'a.txid = txid_current()', 'a.created_at = transaction_timestamp()',
  ];
  const predicateOf = (body: string) => {
    const t = tight(body);
    const from = at(t, `FROM ${STORE} a WHERE `, 'store predicate');
    return t.slice(from + `FROM ${STORE} a WHERE `.length, t.indexOf(') THEN', from)).split(' AND ');
  };

  it('the submission fence judges exactly UPDATE draft -> submitted against the exact same-transaction SUBMIT attestation', () => {
    const body = bodyOf(fn(FENCE));
    expect(tight(body)).toContain("IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'submitted' THEN");
    expect(predicateOf(body)).toEqual(PREDICATE('NEW', 'submit'));
    expect(tight(raiseOf(body, 'central_needs_submission_gate_missing'))).toBe(
      "'central_needs_submission_gate_missing' USING ERRCODE = '23514', DETAIL = format('revision=%s', NEW.id), "
      + "HINT = 'A revision becomes submitted only through phoenix_central_needs_submit_revision.';");
    expect(body).not.toContain('audit_logs');
    expect(body).not.toContain('state_digest');
    expect(executableSql(body)).not.toMatch(/\bOR\b|current_setting|request\.jwt|current_user|session_user|pg_has_role|\b(?:INSERT|UPDATE\s+\w|DELETE|EXECUTE|PERFORM)\b/i);
  });

  it('the approval fence body requires the exact same-transaction APPROVE attestation for a row BECOMING approved — M217\'s transition semantics, never an audit row', () => {
    const body = bodyOf(fn(APPROVAL_BODY));
    expect(tight(body)).toContain("IF p_new.status = 'approved' AND (p_op = 'INSERT' OR p_old.status IS DISTINCT FROM 'approved') THEN");
    expect(predicateOf(body)).toEqual(PREDICATE('p_new', 'approve'));
    expect(tight(raiseOf(body, 'central_needs_approval_gate_missing'))).toBe(
      "'central_needs_approval_gate_missing' USING ERRCODE = '23514', DETAIL = format('revision=%s', p_new.id), "
      + "HINT = 'A revision becomes approved only through phoenix_central_needs_approve_revision.';");
    expect(body).not.toContain('audit_logs');
    expect(body).not.toContain('state_digest');
    expect(bodyOf(fn(APPROVAL_FENCE, M217))).toContain('audit_logs');
    expect(executableSql(body)).not.toMatch(/current_setting|request\.jwt|current_user|session_user|pg_has_role|\b(?:INSERT|UPDATE\s+\w|DELETE|EXECUTE|PERFORM)\b/i);
  });
});

guard('C6-F1/M218 static — submit: the M211 body plus exactly the FINAL additions', () => {
  const NOW = normalizeSql(fn(SUBMIT));
  const WAS = normalizeSql(fn(SUBMIT, M211));
  const ISOLATION = `IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'central_needs_submit_requires_read_committed' USING ERRCODE = '0A000',
      DETAIL = format('transaction_isolation=%s', current_setting('transaction_isolation')),
      HINT = 'Submit the revision in a READ COMMITTED transaction (the default).';
  END IF;`;
  const SEAL = `SELECT x.breach INTO v_breach
    FROM ${BREACHES}() AS x(breach)
   ORDER BY x.breach
   LIMIT 1;
  IF v_breach IS NOT NULL THEN
    RAISE EXCEPTION 'central_needs_capability_seal_breached' USING ERRCODE = '55000',
      DETAIL = v_breach,
      HINT = 'A non-root role holds a capability M218 revokes. Converge the grants (a root-of-trust action) before submitting.';
  END IF;`;
  const STMT = `SELECT b.blocker, b.detail, d.state_digest INTO v_blocker FROM (SELECT ${DIGEST}(p_plan_revision_id) AS state_digest) d LEFT JOIN LATERAL (SELECT x.blocker, x.detail FROM public.${BLOCKERS}(p_plan_revision_id) x LIMIT 1) b ON true;`;
  const M211_STMT = `SELECT blocker, detail INTO v_blocker FROM public.${BLOCKERS}(p_plan_revision_id) LIMIT 1;`;
  const ATTEST = `INSERT INTO ${STORE} ( plan_revision_id, organization_id, phase, contract, actor_id, txid, state_digest ) VALUES ( p_plan_revision_id, v_revision.organization_id, 'submit', '${CONTRACT}', v_actor, txid_current(), v_state_digest );`;
  const GATE_AUDIT = `INSERT INTO public.audit_logs ( organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload ) VALUES ( v_revision.organization_id, v_actor, v_actor_role, 'central_needs.plan_revision.submission_gate', 'central_needs_plan_revision', p_plan_revision_id, format('revision %s', v_revision.revision_number), jsonb_build_object( 'contract', 'c6-f1-v1', 'txid', txid_current()::text, 'plan_id', v_revision.plan_id, 'revision_number', v_revision.revision_number ) );`;

  it('removing exactly the FINAL additions (and restoring M211\'s search_path) leaves the M211 body byte-for-byte (whitespace-normalized)', () => {
    let rest = NOW;
    rest = swap(rest, "SET search_path = pg_catalog, pg_temp SET statement_timeout = '", "SET search_path = public, pg_temp SET statement_timeout = '");
    rest = normalizeSql(rest.replace(/ SET statement_timeout = '\d+s' AS/, ' AS'));
    rest = drop(rest, 'v_state_digest text; v_breach text;');
    rest = drop(rest, ISOLATION);
    rest = drop(rest, SEAL);
    rest = swap(rest, STMT, M211_STMT);
    rest = swap(rest, 'IF v_blocker.blocker IS NOT NULL THEN IF v_blocker.blocker =', 'IF FOUND THEN IF v_blocker.blocker =');
    rest = drop(rest, 'v_state_digest := v_blocker.state_digest;');
    rest = drop(rest, ATTEST);
    rest = drop(rest, GATE_AUDIT);
    rest = swap(rest,
      "'registered_batch_count', v_batches, 'submission_gate_txid', txid_current()::text, "
      + "'revision_xmin', (SELECT r.xmin::text FROM public.central_needs_plan_revisions r WHERE r.id = p_plan_revision_id), "
      + "'submission_state_digest', v_state_digest )", "'registered_batch_count', v_batches )");
    expect(rest).toBe(WAS);
  });

  it('order: isolation, load, guard, draft, the seal predicate, readiness AND the digest in one statement, the refusals, the private SUBMIT attestation, the forensic gate audit, the transition, the submit audit', () => {
    const order = [
      "RAISE EXCEPTION 'central_needs_submit_requires_read_committed'", '_phoenix_central_needs_load_revision_v1(', "'central_needs.edit'",
      '_phoenix_central_needs_assert_draft_v1(', `FROM ${BREACHES}() AS x(breach)`, normalizeSql(STMT),
      'IF v_blocker.blocker IS NOT NULL THEN', "'plan_revision_not_ready_for_review'", 'v_state_digest := v_blocker.state_digest;',
      `INSERT INTO ${STORE}`, "'central_needs.plan_revision.submission_gate'", "SET status = 'submitted'", "'central_needs.plan_revision.submit'",
    ].map((n) => at(NOW, n, n));
    for (let i = 1; i < order.length; i += 1) expect(order[i], `step ${i}`).toBeGreaterThan(order[i - 1]);
  });

  it('the digest is computed exactly once, in the readiness statement; readiness exactly once; the attestation carries no caller input', () => {
    expect(NOW.split(`${DIGEST}(`)).toHaveLength(2);
    expect(NOW.split(`public.${BLOCKERS}(`)).toHaveLength(2);
    expect(NOW).toContain(normalizeSql(ATTEST));
    expect(NOW.split(`INSERT INTO ${STORE}`)).toHaveLength(2);
    expect(NOW).not.toMatch(/pg_advisory|_lock_plan_family_v1|\bLOCK\s+TABLE\b|\bEXCEPTION\s+WHEN\b/i);
  });
});

guard('C6-F1/M218 static — approve: the M217 body plus exactly the FINAL additions (no re-hash)', () => {
  const NOW = normalizeSql(fn(APPROVE));
  const WAS = normalizeSql(fn(APPROVE, M217));
  const PROVENANCE = `SELECT a.state_digest INTO v_submitted_digest
      FROM ${STORE} a JOIN public.central_needs_plan_revisions r ON r.id = a.plan_revision_id
      WHERE a.plan_revision_id = v_revision.id AND a.organization_id = v_revision.organization_id AND a.phase = 'submit'
        AND a.contract = '${CONTRACT}' AND a.xmin = r.xmin AND a.created_at = v_revision.updated_at;
      IF NOT FOUND THEN RAISE EXCEPTION 'central_needs_submission_provenance_missing' USING ERRCODE = '23514',
        DETAIL = format('revision=%s', p_plan_revision_id),
        HINT = 'A revision is approvable only in the submitted state phoenix_central_needs_submit_revision produced. Reject it and correct it through a new draft.';
      END IF;`;
  const SEAL = `SELECT x.breach INTO v_breach
    FROM ${BREACHES}() AS x(breach)
   ORDER BY x.breach
   LIMIT 1;
  IF v_breach IS NOT NULL THEN
    RAISE EXCEPTION 'central_needs_capability_seal_breached' USING ERRCODE = '55000',
      DETAIL = v_breach,
      HINT = 'A non-root role holds a capability M218 revokes. Converge the grants (a root-of-trust action) before approving.';
  END IF;`;
  const ATTEST = `INSERT INTO ${STORE} ( plan_revision_id, organization_id, phase, contract, actor_id, txid, state_digest ) VALUES ( p_plan_revision_id, v_revision.organization_id, 'approve', '${CONTRACT}', v_actor, txid_current(), v_submitted_digest );`;

  it('removing exactly the FINAL additions (and restoring M217\'s search_path) leaves the M217 body byte-for-byte (whitespace-normalized) — the approval-gate comment aside', () => {
    let rest = NOW;
    rest = swap(rest, 'SET search_path = pg_catalog, pg_temp AS', 'SET search_path = public, pg_temp AS');
    rest = drop(rest, 'v_submitted_digest text; v_breach text;');
    rest = drop(rest, PROVENANCE);
    rest = drop(rest, SEAL);
    rest = drop(rest, ATTEST);
    expect(rest).toBe(WAS);
  });

  it('placement: guard, family lock, replay and lifecycle A-D; then provenance and the seal predicate; then E, the beneficiary/warehouse locks, A2; then the APPROVE attestation, the gate audit and the switch', () => {
    const order = [
      "'central_needs.approve'", '_phoenix_central_needs_lock_plan_family_v1', "'idempotent_replay', true", "'plan_revision_not_submitted'",
      'is not the newest revision', 'approved revisions', `FROM ${STORE} a`, "'central_needs_submission_provenance_missing'",
      `FROM ${BREACHES}() AS x(breach)`, "RAISE EXCEPTION 'central_needs_capability_seal_breached'",
      'IF v_approved = 1 THEN', 'FROM public.organizations o', 'FROM public.warehouses w', "'central_needs_approval_eligibility_changed'",
      'A target warehouse became ineligible after submission.', `INSERT INTO ${STORE}`, "'central_needs.plan_revision.approval_gate'",
      "SET status = 'superseded'", "SET status = 'approved'", "'central_needs.plan_revision.approve'",
    ].map((n) => at(NOW, n, n));
    for (let i = 1; i < order.length; i += 1) expect(order[i], `step ${i}`).toBeGreaterThan(order[i - 1]);
  });

  it('never re-hashes: no digest call, no state_changed refusal; the APPROVE attestation carries the SUBMITTED digest; no readiness call, no new audit row, no error translation', () => {
    expect(NOW).not.toContain('central_needs_submission_state_digest_v1');
    expect(NOW).not.toContain('central_needs_submission_state_changed');
    expect(NOW).toContain(normalizeSql(ATTEST));
    const inserts = (s: string) => (executableSql(s).match(/\bINSERT\s+INTO\s+public\.audit_logs\b/gi) ?? []).length;
    expect(inserts(fn(APPROVE))).toBe(inserts(fn(APPROVE, M217)));
    expect(NOW).not.toContain(BLOCKERS);
    expect(NOW).not.toMatch(/\bEXCEPTION\s+WHEN\b/i);
  });
});

guard('C6-F1/M218 static — VERIFY (§14 A-I)', () => {
  it('re-proves every section: root trust, the seal predicate and service_role\'s surface, the private schema, SECURITY DEFINER search paths, sealing, evidence, default privileges, names, data, locks and the catch-all fingerprints', () => {
    const v = tight(VERIFY);
    for (const needle of [
      "'VERIFY FAILED (218): public.% is not owned by the migration owner'",
      "'VERIFY FAILED (218): the owner lost % on public.%'",
      `FROM ${BREACHES}() AS b(breach)`,
      "'VERIFY FAILED (218): a non-root capability remains: %'",
      "'VERIFY FAILED (218): service_role holds CREATE on schema public'",
      "'VERIFY FAILED (218): service_role holds TRIGGER on a public relation'",
      "'VERIFY FAILED (218): service_role Central Needs SECURITY DEFINER EXECUTE is not exactly the three trusted routines'",
      `IS DISTINCT FROM ARRAY[${SVC_KEPT.map((k) => `'${k}'`).join(', ')}]`,
      "'VERIFY FAILED (218): a role other than the owner holds a privilege on the attestation store'",
      "'VERIFY FAILED (218): a role other than the owner holds a privilege on phoenix_private'",
      "'VERIFY FAILED (218): phoenix_private must hold exactly the four security routines, one overload each'",
      "'VERIFY FAILED (218): phoenix_private is configured as a Data API schema'",
      "'VERIFY FAILED (218): % is missing, SECURITY DEFINER, or not pinned to pg_catalog, pg_temp'",
      "'VERIFY FAILED (218): the M217 approval fence lost its C5-pinned shape'",
      "'VERIFY FAILED (218): a SECURITY DEFINER search_path reaches a schema a non-root role can create in: %'",
      "'VERIFY FAILED (218): % names an application relation without its schema'",
      "'VERIFY FAILED (218): the Central Needs writer census changed'",
      "'VERIFY FAILED (218): a routine that mentions Central Needs uses dynamic SQL'",
      "'VERIFY FAILED (218): % must load the revision FOR UPDATE and assert DRAFT before its first write'",
      "'VERIFY FAILED (218): % writes Central Needs state beyond the lifecycle'",
      "'VERIFY FAILED (218): the DRAFT gate no longer refuses every non-draft revision'",
      "'VERIFY FAILED (218): a Central Needs foreign key cascades into sealed state'",
      "'VERIFY FAILED (218): a rule or view depends on a Central Needs relation'",
      "'VERIFY FAILED (218): the Central Needs trigger inventory is not exactly the frozen set'",
      "'VERIFY FAILED (218): a trigger on a public relation runs a routine the root of trust does not own'",
      "'VERIFY FAILED (218): a routine other than submit and approve writes the attestation store'",
      "'VERIFY FAILED (218): approve must not re-hash the sealed submitted state'",
      "'VERIFY FAILED (218): a default privilege of the migration owner grants TRIGGER on future tables to a non-root role'",
      "'VERIFY FAILED (218): a new public table would grant: %'",
      "'VERIFY FAILED (218): an M218 security object exists in public'",
      "'VERIFY FAILED (218): the readiness index is missing or not the frozen partial definition'",
      "'VERIFY FAILED (218): a plan revision status changed'",
      "'VERIFY FAILED (218): the attestation store must start empty'",
      "'VERIFY FAILED (218): the activation lock is not held on all 13 Central Needs tables (got %)'",
      "'VERIFY FAILED (218): another session holds a DDL-class lock on a public relation'",
      "'VERIFY FAILED (218): a routine or trigger outside the deliberate replacements changed'",
      "'VERIFY FAILED (218): an ACL entry outside the deliberate revocations changed'",
      "current_setting('phoenix_m218.untouched_acl', true)",
      "current_setting('phoenix_m218.untouched_functions', true)",
      "current_setting('phoenix_m218.revision_status', true)",
    ]) {
      expect(v, needle).toContain(needle);
    }
    // The catch-alls run last, so every specific check names its own failure first.
    expect(v.indexOf("'VERIFY FAILED (218): an ACL entry outside the deliberate revocations changed'"))
      .toBeGreaterThan(v.indexOf("'VERIFY FAILED (218): another session holds a DDL-class lock on a public relation'"));
  });
});
