/**
 * C5 / M217 — STATIC guard over the Central Needs C5 safety convergence.
 *
 * Proves, from the migration text alone, the frozen C5 v1.9 shape of M217:
 *
 *   * registration and hygiene: the canonical filename, the only file above
 *     216, one BEGIN;/COMMIT;, LF only, no MANUAL APPLY ONLY banner, and
 *     M209-M216 byte-identical to their reviewed content (git blob ids);
 *   * the activation prelude (contract §1): the READ COMMITTED assertion, the
 *     refusal of an applying role that bypasses neither as superuser nor
 *     through BYPASSRLS (the C5 tables are FORCE RLS: such a role would read
 *     every precondition as empty) and the idempotence guard, then SET LOCAL
 *     lock_timeout/statement_timeout, then EXACTLY the two NOWAIT relation
 *     locks, all before any CREATE; the data preconditions after the lock pair;
 *   * the exact DDL inventory: ten functions (three new, seven same-signature
 *     replacements), ONE BEFORE INSERT OR UPDATE trigger on plan_revisions with
 *     no column list, ONE NOT VALID CHECK on source_records — no DROP, no
 *     VALIDATE, no trigger disabling, no session_replication_role, no DML on a
 *     business table, no advisory or row lock outside a function body;
 *   * ACL neutrality (contract §2.6/§22): not one GRANT, REVOKE or DROP names
 *     submit, approve or reject; no schema-wide / ALL FUNCTIONS GRANT or
 *     REVOKE, no ALTER DEFAULT PRIVILEGES, no DROP FUNCTION and no dynamic SQL
 *     that could hide one; every GRANT/REVOKE is one of an exact whitelist on a
 *     C5 function that is not a lifecycle RPC; VERIFY asserts nothing about
 *     their EXECUTE;
 *   * approve's lock order: owner after the guard, then the beneficiary
 *     organizations `ORDER BY o.id FOR SHARE`, then the warehouses
 *     `ORDER BY w.id FOR SHARE`, each scoped to this revision's need lines; no
 *     M217 function translates a lock, deadlock, cancel or serialization error;
 *   * VERIFY's own §1 lock-budget self-check from pg_locks of its backend,
 *     after every lock-taking step;
 *   * attributes and ACL lines of the classifier, the lineage helper and the
 *     approval fence; the codes and DETAIL formats of the frozen interface.
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
import { executableSql, normalizeSql, sqlFunctionSource, stripSqlComments } from './helpers/sql-source';

const MIGRATIONS = join(__dirname, '..');
const FILENAME = '217_phoenix_central_needs_c5_safety_convergence.sql';
const PRESENT = existsSync(join(MIGRATIONS, FILENAME));
const SQL = PRESENT ? readFileSync(join(MIGRATIONS, FILENAME), 'utf8') : '';
const CODE = stripSqlComments(SQL);
const EXEC = executableSql(SQL);

const VERIFY_AT = CODE.indexOf('DO $verify$');
const IMPL = VERIFY_AT >= 0 ? CODE.slice(0, VERIFY_AT) : CODE;
const VERIFY = VERIFY_AT >= 0 ? CODE.slice(VERIFY_AT) : '';

const M210 = readFileSync(join(MIGRATIONS, '210_phoenix_central_needs_workflow_rpcs.sql'), 'utf8');
const M212 = readFileSync(join(MIGRATIONS, '212_phoenix_central_needs_need_lines.sql'), 'utf8');
const M215 = readFileSync(join(MIGRATIONS, '215_phoenix_central_needs_governed_correction_lifecycle.sql'), 'utf8');
const M216 = readFileSync(join(MIGRATIONS, '216_phoenix_central_needs_region_persistence.sql'), 'utf8');

const CLASSIFIER = '_phoenix_central_needs_review_numeric_class_v1';
const LINEAGE = '_phoenix_central_needs_quantity_lineage_violation_v1';
const FENCE = '_phoenix_central_needs_approval_gate_fence_v1';
const LIFECYCLE_RPCS = [
  'phoenix_central_needs_submit_revision',
  'phoenix_central_needs_approve_revision',
  'phoenix_central_needs_reject_revision',
] as const;

/** The seven behaviour-only replacements and the predecessor file holding each latest body. */
const REPLACED: Record<string, string> = {
  _phoenix_central_needs_assert_beneficiary_v1: M212,
  _phoenix_central_needs_review_blockers_v1: M216,
  phoenix_central_needs_list_beneficiary_columns: M216,
  phoenix_central_needs_set_need_line: M216,
  _phoenix_central_needs_assert_need_line_integrity_v1: M216,
  phoenix_central_needs_record_field_override: M210,
  phoenix_central_needs_approve_revision: M215,
};
const NEW_FUNCTIONS = [CLASSIFIER, LINEAGE, FENCE];

const CANDIDATES = ['native_number', 'canonical_integer_text', 'ambiguous_numeric_text'];
const REASONS = [
  'source_cell_value_contract_invalid',
  'source_quantity_requires_explicit_numeric_override',
  'source_quantity_override_binding_invalid',
  'source_quantity_override_value_invalid',
  'source_quantity_override_mismatch',
];

const gitBlob = (content: Buffer) =>
  createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])).digest('hex');

/** Whitespace normalized, and no space just inside parentheses: layout-insensitive statement text. */
const tight = (sql: string) => normalizeSql(sql).replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');

/** The RAISE statement of `code` in `body`: from the code literal to the end of its statement. */
function raiseOf(body: string, code: string): string {
  const i = at(body, `'${code}'`, code);
  return body.slice(i, body.indexOf(';', i) + 1);
}

/** The comment-stripped source of one function (literals kept); fails when absent. */
function fn(name: string, sql = SQL): string {
  const src = sqlFunctionSource(sql, name);
  expect(src, `${name} is defined`).not.toBeNull();
  return src ?? '';
}

/** Index of `needle` in `text`, asserted present. */
function at(text: string, needle: string | RegExp, label: string): number {
  const i = typeof needle === 'string' ? text.indexOf(needle) : text.search(needle);
  expect(i, `${label} present`).toBeGreaterThanOrEqual(0);
  return i;
}

/**
 * Header of a function: the parameter list (balanced parentheses, whitespace
 * normalized) and the attribute text between it and the body's AS.
 */
function header(sql: string, name: string): { params: string; attrs: string; returns: string } {
  const code = stripSqlComments(sql);
  const m = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`).exec(code);
  expect(m, `${name} header`).not.toBeNull();
  let i = (m?.index ?? 0) + (m?.[0].length ?? 0);
  let depth = 1;
  const start = i;
  while (i < code.length && depth > 0) {
    if (code[i] === '(') depth += 1;
    if (code[i] === ')') depth -= 1;
    i += 1;
  }
  const params = tight(code.slice(start, i - 1));
  const asAt = code.slice(i).search(/\bAS\s+\$/);
  const attrs = tight(code.slice(i, i + asAt));
  const returns = /RETURNS\s+(TABLE\s*\([^)]*\)|[A-Za-z_][\w.]*(?:%ROWTYPE)?(?:\s*\[\])?)/i.exec(attrs)?.[1] ?? '';
  return { params, attrs, returns: tight(returns) };
}

/**
 * EXEC with every CREATE ... FUNCTION definition (header and body) removed:
 * what runs AT MIGRATION TIME. DO blocks stay, because they execute too.
 */
function outsideFunctionBodies(exec: string): string {
  let out = exec;
  for (;;) {
    const m = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.\w+\s*\(/.exec(out);
    if (!m) return out;
    const rest = out.slice(m.index);
    const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (!open) return out;
    const close = rest.indexOf(open[0], open.index + open[0].length);
    if (close < 0) return out;
    out = out.slice(0, m.index) + '/*fn*/' + rest.slice(close + open[0].length);
  }
}

/** Top-level statements of EXEC, with every dollar-quoted body collapsed to `$$`. */
function topLevelStatements(exec: string): string[] {
  let flat = '';
  let i = 0;
  while (i < exec.length) {
    const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(exec.slice(i));
    if (open) {
      const close = exec.indexOf(open[0], i + open[0].length);
      flat += '$$';
      i = close < 0 ? exec.length : close + open[0].length;
      continue;
    }
    flat += exec[i];
    i += 1;
  }
  return flat.split(';').map((s) => tight(s)).filter((s) => s.length > 0);
}

const guard = PRESENT ? describe : describe.skip;

describe('C5/M217 static — the file exists under its canonical name', () => {
  it(`${FILENAME} is present (written by the M217 workstream)`, () => {
    expect(PRESENT, `${FILENAME} is not on disk yet`).toBe(true);
  });
});

guard('C5/M217 static — registration, hygiene and frozen predecessors', () => {
  it('217 is the next migration after 216 and the only file above 216', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files).toContain(FILENAME);
    expect(files.filter((f) => Number(f.slice(0, 3)) > 216)).toEqual([FILENAME]);
    expect(files[files.indexOf(FILENAME) - 1]).toBe('216_phoenix_central_needs_region_persistence.sql');
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

  it('leaves M209-M216 byte-identical (git blob ids of the frozen baseline)', () => {
    const baseline: Record<string, string> = {
      '209_phoenix_central_needs_registry.sql': '9378bdaf44e6808ac9a0b0abb4ab42c6e283e9e1',
      '210_phoenix_central_needs_workflow_rpcs.sql': 'f61c5206ab843a2bc50dfae972d998700aa9f2bc',
      '211_phoenix_central_needs_batch_and_disposition.sql': '999c6c62154827bd350fea681678a1fa22d74e1e',
      '212_phoenix_central_needs_need_lines.sql': '938a6c7f8a10ff2e89cf5496b46affe43bc1db58',
      '213_phoenix_central_needs_beneficiary_column_mapping.sql': 'a465d323b2cfc9e72e43b9c577163a045c28aa6a',
      '214_phoenix_central_needs_review_readiness_volatility.sql': '2954b3bf349370a6a2701216dc89e3385873601c',
      '215_phoenix_central_needs_governed_correction_lifecycle.sql': '5f1c6bbbb2c2be46c9d7a28642c01e12b76e4c29',
      '216_phoenix_central_needs_region_persistence.sql': 'e87e71effddfc88ede944d52312aca20dbdde391',
    };
    for (const [file, blob] of Object.entries(baseline)) {
      expect(gitBlob(readFileSync(join(MIGRATIONS, file))), file).toBe(blob);
    }
  });
});

guard('C5/M217 static — activation prelude and lock budget (contract §1)', () => {
  const LOCK_SOURCE = 'LOCK TABLE public.central_needs_source_records IN ACCESS EXCLUSIVE MODE NOWAIT;';
  const LOCK_REVISIONS = 'LOCK TABLE public.central_needs_plan_revisions IN EXCLUSIVE MODE NOWAIT;';

  it('asserts READ COMMITTED, then idempotence, then lock_timeout 250ms, then statement_timeout 60s — before the lock pair', () => {
    const isolation = at(CODE, "'217_requires_read_committed'", 'isolation assertion');
    expect(CODE.slice(0, isolation)).toMatch(/transaction_isolation/);
    const idempotence = at(CODE, "'217_already_applied'", 'idempotence guard');
    const lockTimeout = at(CODE, /SET\s+LOCAL\s+lock_timeout\s*(?:=|TO)\s*'250ms'\s*;/i, 'SET LOCAL lock_timeout');
    const stmtTimeout = at(CODE, /SET\s+LOCAL\s+statement_timeout\s*(?:=|TO)\s*'60s'\s*;/i, 'SET LOCAL statement_timeout');
    const lock1 = at(CODE, LOCK_SOURCE, 'source_records lock');
    const lock2 = at(CODE, LOCK_REVISIONS, 'plan_revisions lock');
    expect(isolation).toBeLessThan(idempotence);
    expect(idempotence).toBeLessThan(lockTimeout);
    expect(lockTimeout).toBeLessThan(stmtTimeout);
    expect(stmtTimeout).toBeLessThan(lock1);
    expect(lock1).toBeLessThan(lock2);
    // Nothing is created before the pair is held.
    expect(lock2).toBeLessThan(at(CODE, /\bCREATE\b/, 'first CREATE'));
    expect(lock2).toBeLessThan(at(CODE, /\bALTER\s+TABLE\b/, 'ALTER TABLE'));
    // Idempotence keys on the classifier or the fence trigger.
    const guardBlock = CODE.slice(0, lock1);
    expect(guardBlock).toContain(CLASSIFIER);
    expect(guardBlock).toContain('central_needs_plan_revisions_c5_approval_gate');
    // Dependency existence failures carry the '217_precondition_failed:' prefix and precede the locks.
    expect(guardBlock).toMatch(/'217_precondition_failed: /);
  });

  it('refuses an applying role that is neither superuser nor BYPASSRLS, inside the prelude, after READ COMMITTED, before any lock', () => {
    const RLS = '217_precondition_failed: the applying role must bypass row-level security';
    const preludeAt = at(CODE, 'DO $prelude$', 'prelude DO block');
    const preludeEnd = CODE.indexOf('$prelude$;', preludeAt);
    expect(preludeEnd, 'prelude terminator').toBeGreaterThan(preludeAt);
    const isolation = at(CODE, "'217_requires_read_committed'", 'isolation assertion');
    const rls = at(CODE, `'${RLS}'`, 'RLS-bypass refusal');
    const lockTimeout = at(CODE, /SET\s+LOCAL\s+lock_timeout/i, 'SET LOCAL lock_timeout');
    const lock1 = at(CODE, 'LOCK TABLE public.central_needs_source_records', 'source_records lock');
    expect(rls).toBeGreaterThan(preludeAt);
    expect(rls).toBeLessThan(preludeEnd);
    expect(isolation).toBeLessThan(rls);
    expect(rls).toBeLessThan(lockTimeout);
    expect(rls).toBeLessThan(lock1);
    // The condition: the CURRENT role's own attributes, superuser OR BYPASSRLS — nothing else satisfies it.
    const condition = tight(CODE.slice(CODE.lastIndexOf('IF', rls), rls));
    expect(condition).toMatch(
      /^IF NOT \(SELECT (?:\w+\.)?rolsuper OR (?:\w+\.)?rolbypassrls FROM pg_roles(?: \w+)? WHERE (?:\w+\.)?rolname = current_user\) THEN RAISE EXCEPTION$/);
    const raise = tight(raiseOf(CODE, RLS));
    expect(raise).toMatch(/USING DETAIL = format\('role=%s', current_user\);$/);
    // Exactly one such refusal, and the prelude reads no application table.
    expect(CODE.split(`'${RLS}'`)).toHaveLength(2);
    expect(executableSql(CODE.slice(preludeAt, preludeEnd))).not.toMatch(/\bFROM\s+public\./i);
  });

  it('takes exactly the two relation locks, in the frozen modes, NOWAIT, and no other LOCK', () => {
    const locks = [...EXEC.matchAll(/\bLOCK\s+(?:TABLE\s+)?[^;]*;/gi)].map((m) => normalizeSql(m[0]));
    expect(locks).toEqual([LOCK_SOURCE, LOCK_REVISIONS]);
    expect(EXEC.match(/SET\s+LOCAL\s+\w+/gi)?.map((s) => normalizeSql(s))).toEqual(['SET LOCAL lock_timeout', 'SET LOCAL statement_timeout']);
    expect(EXEC).not.toMatch(/\bSET\s+(?:SESSION\s+)?(?:TRANSACTION|CHARACTERISTICS)\b/i);
  });

  it('runs the three data preconditions (plain SELECT) AFTER the lock pair, with the frozen DETAIL', () => {
    const lock2 = at(CODE, LOCK_REVISIONS, 'plan_revisions lock');
    const detail = at(CODE, "'submitted=%s draft_invalid=%s draft_unsafe_links=%s'", 'precondition DETAIL');
    expect(detail).toBeGreaterThan(lock2);
    const block = CODE.slice(lock2, detail);
    expect(block).toContain("'217_precondition_failed");
    expect(block).toMatch(/status\s*=\s*'submitted'/);
    expect(block).toMatch(/status\s*=\s*'completed'/);
    expect(block).toMatch(/status\s*=\s*'draft'/);
    expect(block).toContain("'invalid_evidence'");
    expect(block).toContain(LINEAGE);
    expect(block).toContain(CLASSIFIER);
  });

  it('holds no advisory lock and no row lock outside a function body, and waits on nothing', () => {
    const outside = outsideFunctionBodies(EXEC);
    expect(EXEC).not.toMatch(/pg_advisory/i);
    expect(outside).not.toMatch(/\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/i);
    expect(outside).not.toMatch(/\bFOR\s+(?:KEY\s+)?SHARE\b/i);
    expect(outside).not.toMatch(/\bpg_sleep\b/i);
  });
});

guard('C5/M217 static — exact DDL inventory', () => {
  const OUTSIDE = outsideFunctionBodies(EXEC);
  const STATEMENTS = topLevelStatements(EXEC);

  it('creates exactly the ten frozen functions, each once: three new and seven replacements', () => {
    const created = [...EXEC.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(/g)].map((m) => m[1]);
    expect([...created].sort()).toEqual([...NEW_FUNCTIONS, ...Object.keys(REPLACED)].sort());
    expect(new Set(created).size).toBe(created.length);
    for (const name of Object.keys(REPLACED)) {
      expect(EXEC, `${name} is replaced in place`).toMatch(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\(`));
    }
    for (const name of NEW_FUNCTIONS) expect(name, 'no new helper name contains region').not.toMatch(/region/);
  });

  it('every top-level statement is of an allowed kind, with exact counts', () => {
    const kinds = STATEMENTS.map((s) => {
      const k = /^(BEGIN|COMMIT|DO|SET LOCAL|LOCK TABLE|CREATE OR REPLACE FUNCTION|CREATE FUNCTION|CREATE TRIGGER|ALTER TABLE|REVOKE|GRANT|COMMENT ON (?:FUNCTION|CONSTRAINT|TRIGGER)|SELECT)\b/.exec(s);
      return k ? k[1] : `UNEXPECTED: ${s.slice(0, 80)}`;
    });
    expect(kinds.filter((k) => k.startsWith('UNEXPECTED'))).toEqual([]);
    const count = (k: string) => kinds.filter((x) => x === k).length;
    expect(count('BEGIN')).toBe(1);
    expect(count('COMMIT')).toBe(1);
    expect(count('SET LOCAL')).toBe(2);
    expect(count('LOCK TABLE')).toBe(2);
    expect(count('CREATE TRIGGER')).toBe(1);
    expect(count('ALTER TABLE')).toBe(1);
    expect(count('CREATE OR REPLACE FUNCTION') + count('CREATE FUNCTION')).toBe(10);
  });

  it('exactly ONE trigger: the approval fence, BEFORE INSERT OR UPDATE on plan_revisions, no column list, FOR EACH ROW', () => {
    const triggers = STATEMENTS.filter((s) => /^CREATE (?:CONSTRAINT )?TRIGGER\b/.test(s));
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatch(new RegExp(
      '^CREATE TRIGGER central_needs_plan_revisions_c5_approval_gate BEFORE INSERT OR UPDATE '
      + `ON public\\.central_needs_plan_revisions FOR EACH ROW EXECUTE (?:FUNCTION|PROCEDURE) public\\.${FENCE}\\(\\)$`));
    expect(OUTSIDE).not.toMatch(/\bUPDATE\s+OF\b/i);
    expect(EXEC).not.toMatch(/CREATE\s+CONSTRAINT\s+TRIGGER/i);
  });

  it('exactly ONE constraint: the future-write source-value CHECK, NOT VALID, on source_records', () => {
    const alters = STATEMENTS.filter((s) => /^ALTER TABLE\b/.test(s));
    expect(alters).toHaveLength(1);
    expect(tight(CODE)).toContain(tight(
      'ALTER TABLE public.central_needs_source_records ADD CONSTRAINT central_needs_source_records_c5_value_contract '
      + `CHECK (COALESCE(public.${CLASSIFIER}(source_values), 'invalid_evidence') <> 'invalid_evidence') NOT VALID;`));
    expect(OUTSIDE.match(/\bADD\s+CONSTRAINT\b/gi)).toHaveLength(1);
    expect(OUTSIDE.match(/\bNOT\s+VALID\b/gi)).toHaveLength(1);
  });

  it('no DROP, no VALIDATE, no trigger disabling, no replication-role switch, no new table/index/policy/view/type', () => {
    for (const forbidden of [
      /\bDROP\b/i, /\bVALIDATE\s+CONSTRAINT\b/i, /\bDISABLE\s+TRIGGER\b/i, /\bENABLE\s+(?:ALWAYS|REPLICA)\s+TRIGGER\b/i,
      /session_replication_role/i, /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\b/i, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
      /\bCREATE\s+POLICY\b/i, /\bALTER\s+POLICY\b/i, /\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i, /\bCREATE\s+TYPE\b/i,
      /\bCREATE\s+SEQUENCE\b/i, /\bCREATE\s+EXTENSION\b/i, /\bALTER\s+FUNCTION\b/i, /\bADD\s+COLUMN\b/i,
      /\bCOMMENT\s+ON\s+(?:TABLE|COLUMN)\b/i, /\bSECURITY\s+LABEL\b/i, /\bOWNER\s+TO\b/i,
    ]) {
      expect(EXEC, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('F-2: set_config names only M217\'s own phoenix_m217.* fingerprints — no GUC (session_replication_role, role, …) is switched through a function call, which EXEC (literals blanked) cannot see', () => {
    // CODE keeps string literals, so the first argument of every set_config call is visible here.
    const names = [...CODE.matchAll(/\bset_config\s*\(\s*([^,]*),/gi)].map((m) => m[1].trim());
    expect(names).toEqual(["'phoenix_m217.lifecycle_acl'", "'phoenix_m217.revision_status'"]);
    expect(CODE).not.toMatch(/session_replication_role|'role'|"role"|session_authorization/i);
  });

  it('writes no business row at migration time (DML appears only inside function bodies)', () => {
    expect(OUTSIDE).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(OUTSIDE).not.toMatch(/\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?\w+\s+SET\b/i);
    expect(OUTSIDE).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(OUTSIDE).not.toMatch(/\bTRUNCATE\b/i);
    expect(OUTSIDE).not.toMatch(/\bCOPY\b/i);
    expect(OUTSIDE).not.toMatch(/\bMERGE\s+INTO\b/i);
  });
});

guard('C5/M217 static — ACL neutrality for submit, approve and reject (contract §2.6/§22)', () => {
  it('no GRANT, REVOKE or DROP statement anywhere names the three lifecycle RPCs', () => {
    const dcl = [...EXEC.matchAll(/\b(?:GRANT|REVOKE|DROP)\b[^;]*;/gi)].map((m) => m[0]);
    for (const stmt of dcl) {
      for (const rpc of LIFECYCLE_RPCS) expect(stmt, rpc).not.toContain(rpc);
    }
    expect(EXEC).not.toMatch(/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i);
  });

  it('no schema-wide or ALL FUNCTIONS GRANT/REVOKE, no ALTER DEFAULT PRIVILEGES, no DROP FUNCTION, no ownership or role DCL', () => {
    // A blanket grant names no RPC, yet would re-open EXECUTE on the frozen
    // submit/approve (and the internal helpers) mid-activation; DROP + CREATE
    // would reset their ACL to the default. Neither may appear in any form.
    for (const forbidden of [
      /\b(?:GRANT|REVOKE)\b[^;]*\bALL\s+(?:FUNCTIONS|ROUTINES|PROCEDURES|TABLES|SEQUENCES)\s+IN\s+SCHEMA\b/i,
      /\b(?:GRANT|REVOKE)\b[^;]*\bON\s+(?:SCHEMA|DATABASE|LANGUAGE|TYPE|DOMAIN|LARGE\s+OBJECT|FOREIGN|TABLESPACE|PARAMETER)\b/i,
      /\bGRANT\b[^;]*\bTO\s+(?:[\w"]+\s*,\s*)*PUBLIC\b/i,
      /\bGRANT\b[^;]*\bWITH\s+(?:GRANT|ADMIN)\s+OPTION\b/i,
      /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i,
      /\bDROP\s+(?:FUNCTION|ROUTINE|PROCEDURE|AGGREGATE|OWNED)\b/i,
      /\bREASSIGN\s+OWNED\b/i,
      /\bALTER\s+(?:FUNCTION|ROUTINE|PROCEDURE|SCHEMA|ROLE|USER|GROUP)\b/i,
      /\b(?:CREATE|DROP)\s+(?:ROLE|USER|GROUP)\b/i,
      /\bSET\s+(?:LOCAL\s+|SESSION\s+)?(?:ROLE|SESSION\s+AUTHORIZATION)\b/i,
    ]) {
      expect(EXEC, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('no dynamic SQL at all: a GRANT, REVOKE or DROP cannot hide inside a string literal the negative guards blank', () => {
    const rest = EXEC
      .replace(/\bGRANT\s+EXECUTE\s+ON\s+FUNCTION\b/gi, '')
      .replace(/\bFOR\s+EACH\s+ROW\s+EXECUTE\s+(?:FUNCTION|PROCEDURE)\b/gi, '');
    expect(rest).not.toMatch(/\bEXECUTE\b/i);
    expect(EXEC).not.toMatch(/\bdblink\w*\s*\(/i);
  });

  it('every GRANT and REVOKE is one of an exact whitelist, each on ONE named C5 function that is not a lifecycle RPC', () => {
    const dcl = topLevelStatements(EXEC).filter((s) => /^(?:GRANT|REVOKE)\b/i.test(s));
    expect(dcl).toEqual([
      `REVOKE ALL ON FUNCTION public.${CLASSIFIER}(jsonb) FROM PUBLIC, anon`,
      `GRANT EXECUTE ON FUNCTION public.${CLASSIFIER}(jsonb) TO authenticated, service_role`,
      `REVOKE ALL ON FUNCTION public.${LINEAGE}(uuid) FROM PUBLIC, anon, authenticated, service_role`,
      'REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid) FROM PUBLIC, anon, authenticated',
      'REVOKE ALL ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid) FROM PUBLIC, anon, authenticated',
      'REVOKE ALL ON FUNCTION public.phoenix_central_needs_list_beneficiary_columns(uuid) FROM PUBLIC, anon',
      'GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_list_beneficiary_columns(uuid) TO authenticated',
      'REVOKE ALL ON FUNCTION public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text) FROM PUBLIC, anon',
      'GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text) TO authenticated',
      'REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1() FROM PUBLIC, anon, authenticated',
      'REVOKE ALL ON FUNCTION public.phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text) FROM PUBLIC, anon',
      'GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text) TO authenticated',
      `REVOKE ALL ON FUNCTION public.${FENCE}() FROM PUBLIC, anon, authenticated, service_role`,
    ]);
    const allowed = new Set([...NEW_FUNCTIONS, ...Object.keys(REPLACED)]);
    for (const stmt of dcl) {
      const m = /^(?:GRANT EXECUTE|REVOKE ALL) ON FUNCTION public\.(\w+)\([^()]*\) (?:TO|FROM) [\w, ]+$/.exec(stmt);
      expect(m, `one function per statement: ${stmt}`).not.toBeNull();
      const target = m?.[1] ?? '';
      expect(allowed.has(target), `${target} is a C5 function`).toBe(true);
      expect(LIFECYCLE_RPCS as readonly string[], `${target} is not a lifecycle RPC`).not.toContain(target);
    }
    // No GRANT/REVOKE hides inside a DO block or a function body either: every
    // occurrence of the keywords in executable SQL is one of the top-level
    // statements above (bodies are collapsed by topLevelStatements).
    expect((EXEC.match(/\b(?:GRANT|REVOKE)\b/gi) ?? []).length).toBe(dcl.length);
  });

  it('approve is replaced with its identical signature via CREATE OR REPLACE and is the only lifecycle RPC replaced', () => {
    expect(EXEC).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.phoenix_central_needs_approve_revision\s*\(/);
    for (const rpc of ['phoenix_central_needs_submit_revision', 'phoenix_central_needs_reject_revision',
      'phoenix_central_needs_review_readiness', 'phoenix_central_needs_open_plan_revision',
      'phoenix_central_needs_open_correction_revision', '_phoenix_central_needs_lock_plan_family_v1']) {
      expect(EXEC, rpc).not.toMatch(new RegExp(`FUNCTION\\s+public\\.${rpc}\\s*\\(`));
    }
    const now = header(SQL, 'phoenix_central_needs_approve_revision');
    const was = header(M215, 'phoenix_central_needs_approve_revision');
    expect(now.params).toBe('p_plan_revision_id uuid');
    expect(now.params).toBe(was.params);
    expect(now.returns).toBe('jsonb');
    expect(now.attrs).toMatch(/LANGUAGE plpgsql/);
    expect(now.attrs).toMatch(/SECURITY DEFINER/);
    expect(now.attrs).toMatch(/SET search_path = public, pg_temp/);
  });

  it('VERIFY asserts nothing about the EXECUTE privilege of submit, approve or reject', () => {
    // It may compare their ACL with the value captured before M217 (neutrality);
    // it must never assert what their client EXECUTE is (§2.6: the activation
    // runbook holds them frozen while M217 runs).
    const calls = [...VERIFY.matchAll(/has_function_privilege\s*\(([^;]*?)\)/gi)].map((m) => m[1]);
    for (const c of calls) for (const rpc of LIFECYCLE_RPCS) expect(c, rpc).not.toContain(rpc);
    for (const block of VERIFY.split(/\bIF\b/).filter((b) => /aclexplode/i.test(b))) {
      for (const rpc of LIFECYCLE_RPCS) expect(block, `aclexplode assertion on ${rpc}`).not.toContain(rpc);
    }
  });
});

guard('C5/M217 static — attributes and ACL of the three new functions', () => {
  const ACL = tight(IMPL);

  it('classifier: sql IMMUTABLE, CALLED ON NULL INPUT, SECURITY INVOKER, pinned search_path; EXECUTE for authenticated and service_role only', () => {
    const h = header(SQL, CLASSIFIER);
    expect(h.params).toMatch(/^(?:\w+\s+)?jsonb$/);
    expect(h.returns).toBe('text');
    expect(h.attrs).toMatch(/LANGUAGE sql/);
    expect(h.attrs).toMatch(/\bIMMUTABLE\b/);
    expect(h.attrs).not.toMatch(/\bSTRICT\b|RETURNS NULL ON NULL INPUT/);
    expect(h.attrs).not.toMatch(/SECURITY DEFINER/);
    expect(h.attrs).toMatch(/SECURITY INVOKER/);
    expect(h.attrs).toMatch(/SET search_path = public, pg_temp/);
    expect(ACL).toContain(`REVOKE ALL ON FUNCTION public.${CLASSIFIER}(jsonb) FROM PUBLIC, anon;`);
    expect(ACL).toContain(`GRANT EXECUTE ON FUNCTION public.${CLASSIFIER}(jsonb) TO authenticated, service_role;`);
    // The body is the frozen §5 rule set: every output token, both regexes, the three digit ranges.
    const body = fn(CLASSIFIER);
    for (const token of [...CANDIDATES, 'not_numeric', 'invalid_evidence']) expect(body, token).toContain(`'${token}'`);
    expect(body).toContain("'^(?:0|[1-9][0-9]*)$'");
    expect(body).toContain('256');
    expect(body).toContain('[Nn][Aa][Nn]');
    expect(body).toContain('[Ii][Nn][Ff][Ii][Nn][Ii][Tt][Yy]');
    for (const range of ['0660', '0669', '06F0', '06F9', 'FF10', 'FF19']) expect(body.toUpperCase(), range).toContain(range);
    for (const vt of ["'number'", "'string'", "'boolean'", "'date'", "'error'"]) expect(body, vt).toContain(vt);
    expect(body).not.toMatch(/\bRAISE\b/);
  });

  it('lineage helper: sql STABLE SECURITY DEFINER, pinned search_path, no client EXECUTE at all, no writes', () => {
    const h = header(SQL, LINEAGE);
    expect(h.params).toMatch(/^(?:\w+\s+)?uuid$/);
    expect(h.returns).toBe('text');
    expect(h.attrs).toMatch(/LANGUAGE sql/);
    expect(h.attrs).toMatch(/\bSTABLE\b/);
    expect(h.attrs).toMatch(/SECURITY DEFINER/);
    expect(h.attrs).toMatch(/SET search_path = public, pg_temp/);
    expect(ACL).toContain(`REVOKE ALL ON FUNCTION public.${LINEAGE}(uuid) FROM PUBLIC, anon, authenticated, service_role;`);
    expect(ACL).not.toMatch(new RegExp(`GRANT[^;]*${LINEAGE}`));
    const body = fn(LINEAGE);
    for (const reason of REASONS) expect(body, reason).toContain(`'${reason}'`);
    // First-failure order §9: A invalid, B safe classes, C no override, D binding, E value, F mismatch.
    let last = -1;
    for (const token of REASONS) {
      const i = body.indexOf(`'${token}'`);
      expect(i, token).toBeGreaterThan(last);
      last = i;
    }
    expect(body.indexOf("'draft'")).toBeGreaterThan(0);
    expect(body).toContain(CLASSIFIER);
    expect(body).toMatch(/created_at\s+DESC\s*,\s*(?:\w+\.)?id\s+DESC/i);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|EXECUTE|RAISE)\b/);
  });

  it('approval fence: plpgsql trigger function, SECURITY DEFINER, pinned search_path, revoked from every client role', () => {
    const h = header(SQL, FENCE);
    expect(h.params).toBe('');
    expect(h.returns).toBe('trigger');
    expect(h.attrs).toMatch(/LANGUAGE plpgsql/);
    expect(h.attrs).toMatch(/SECURITY DEFINER/);
    expect(h.attrs).toMatch(/SET search_path = public, pg_temp/);
    expect(ACL).toContain(`REVOKE ALL ON FUNCTION public.${FENCE}() FROM PUBLIC, anon, authenticated, service_role;`);
    expect(ACL).not.toMatch(new RegExp(`GRANT[^;]*${FENCE}`));
  });

  it('every SECURITY DEFINER function in the file pins search_path = public, pg_temp', () => {
    for (const name of [...NEW_FUNCTIONS, ...Object.keys(REPLACED)]) {
      const h = header(SQL, name);
      if (/SECURITY DEFINER/.test(h.attrs)) expect(h.attrs, name).toMatch(/SET search_path = public, pg_temp/);
    }
  });
});

guard('C5/M217 static — the seven replacements keep their exact signatures and house ACL', () => {
  const ACL = tight(IMPL);

  it('parameters, return type, language and security mode are identical to the latest predecessor body', () => {
    for (const [name, predecessor] of Object.entries(REPLACED)) {
      const now = header(SQL, name);
      const was = header(predecessor, name);
      expect(now.params, `${name} parameters`).toBe(was.params);
      expect(now.returns, `${name} return type`).toBe(was.returns);
      expect(/LANGUAGE (\w+)/.exec(now.attrs)?.[1], `${name} language`).toBe(/LANGUAGE (\w+)/.exec(was.attrs)?.[1]);
      expect(/SECURITY (DEFINER|INVOKER)/.test(now.attrs) ? /SECURITY (DEFINER|INVOKER)/.exec(now.attrs)?.[1] : 'INVOKER',
        `${name} security`).toBe(/SECURITY (DEFINER|INVOKER)/.test(was.attrs) ? /SECURITY (DEFINER|INVOKER)/.exec(was.attrs)?.[1] : 'INVOKER');
      expect(now.attrs, `${name} search_path`).toMatch(/SET search_path = public, pg_temp/);
    }
    expect(header(SQL, 'phoenix_central_needs_list_beneficiary_columns').attrs).toMatch(/SECURITY INVOKER/);
  });

  it('replaced client RPCs keep REVOKE ALL FROM PUBLIC, anon + GRANT EXECUTE TO authenticated (approve excepted)', () => {
    for (const sig of [
      'phoenix_central_needs_list_beneficiary_columns(uuid)',
      'phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)',
      'phoenix_central_needs_record_field_override(uuid, jsonb, text, text, text)',
    ]) {
      expect(ACL, `${sig} revoke`).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon;`);
      expect(ACL, `${sig} grant`).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated;`);
    }
  });

  it('replaced internal helpers keep REVOKE ALL FROM PUBLIC, anon, authenticated and gain no grant', () => {
    for (const sig of [
      '_phoenix_central_needs_assert_beneficiary_v1(uuid, uuid)',
      '_phoenix_central_needs_review_blockers_v1(uuid)',
      '_phoenix_central_needs_assert_need_line_integrity_v1()',
    ]) {
      expect(ACL, sig).toMatch(new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${sig.replace(/[()[\]]/g, '\\$&')} FROM PUBLIC, anon, authenticated(?:, service_role)?;`));
      expect(ACL, sig).not.toMatch(new RegExp(`GRANT[^;]*${sig.slice(0, sig.indexOf('('))}`));
    }
  });

  it('only readiness and submit may call the blockers function: no M217 function references it', () => {
    for (const name of [...NEW_FUNCTIONS, ...Object.keys(REPLACED)]) {
      if (name === '_phoenix_central_needs_review_blockers_v1') continue;
      expect(fn(name), name).not.toContain('_phoenix_central_needs_review_blockers_v1');
    }
  });
});

guard('C5/M217 static — codes and DETAIL formats of the frozen interface', () => {
  it('set_need_line: the §10 lexeme grammar precedes the numeric cast; missing/null keeps its own code', () => {
    const body = fn('phoenix_central_needs_set_need_line');
    const missing = at(body, "'source_link_requires_designated_quantity'", 'missing designatedQuantity');
    const grammar = at(body, "'designated_quantity_not_canonical'", 'grammar refusal');
    const cast = at(body, "(v_src->>'designatedQuantity')::numeric", 'numeric cast');
    expect(missing).toBeLessThan(grammar);
    expect(grammar).toBeLessThan(cast);
    const check = body.slice(missing, cast);
    expect(check).toContain("'^(?:0|[1-9][0-9]*)(?:[.][0-9]+)?$'");
    expect(check).toContain('256');
    expect(check).toMatch(/jsonb_typeof\(v_src->'designatedQuantity'\)[^;]*'string'/);
    const raise = raiseOf(body, 'designated_quantity_not_canonical');
    expect(raise).toContain("ERRCODE = '23514'");
    expect(raise).toMatch(/DETAIL = format\('source_record=%s', v_record_id\)/);
  });

  it('set_need_line: the shared helper judges each NEW link right after its INSERT, with the frozen DETAIL', () => {
    const body = fn('phoenix_central_needs_set_need_line');
    const insert = at(body, 'INSERT INTO public.central_needs_need_line_sources', 'link insert');
    const helper = at(body, `public.${LINEAGE}(`, 'helper call');
    const raise = at(body, "'need_line_quantity_lineage_unsafe'", 'lineage refusal');
    const added = at(body, 'v_added_count := v_added_count + 1', 'added count');
    expect(insert).toBeLessThan(helper);
    expect(helper).toBeLessThan(raise);
    expect(raise).toBeLessThan(added);
    expect(body.slice(insert, helper)).toMatch(/RETURNING\s+id\s+INTO/);
    const r = raiseOf(body, 'need_line_quantity_lineage_unsafe');
    expect(r).toContain("'session=%s source_record=%s need_line=%s reason=%s'");
    expect(r).toContain("ERRCODE = '23514'");
    // Every M216 refusal survives the replacement.
    for (const code of ['beneficiary_column_mapping_required', 'beneficiary_column_not_beneficiary', 'beneficiary_column_mapping_conflict',
      'beneficiary_decision_grain_conflict', 'beneficiary_region_required', 'beneficiary_region_overlap',
      'beneficiary_region_not_beneficiary', 'beneficiary_region_mapping_conflict', 'applied_override_does_not_match_source_record',
      'source_record_already_linked', 'need_line_quantity_provenance_mismatch', 'need_line_lineage_stale']) {
      expect(body, code).toContain(`'${code}'`);
    }
    expect(body).toContain('_phoenix_central_needs_resolve_column_mapping_v1');
  });

  it('deferred integrity: event-scoped C5 check with the SAME code and DETAIL; M212-M216 clauses kept', () => {
    const body = fn('_phoenix_central_needs_assert_need_line_integrity_v1');
    expect(body).toContain(`public.${LINEAGE}(`);
    const r = raiseOf(body, 'need_line_quantity_lineage_unsafe');
    expect(r).toContain("'session=%s source_record=%s need_line=%s reason=%s'");
    expect(r).toContain("ERRCODE = '23514'");
    for (const col of ['need_line_id', 'source_record_id', 'designated_quantity', 'applied_override_id']) {
      expect(body, col).toMatch(new RegExp(`OLD\\.${col}`));
    }
    expect(body).toMatch(/OLD\.plan_revision_id/);
    expect(body).toMatch(/OLD\.organization_id/);
    for (const code of ['need_line_requires_source_lineage', 'need_line_quantity_provenance_mismatch',
      'need_line_material_mapping_conflict', 'need_line_scope_mixes_institution_and_warehouse',
      'beneficiary_column_mapping_conflict', 'beneficiary_region_mapping_conflict', 'beneficiary_column_mapping_in_use',
      'beneficiary_region_in_use']) {
      expect(body, code).toContain(`'${code}'`);
    }
    expect(body).toContain('_phoenix_central_needs_region_column_covered_v1');
    expect(body).not.toContain('audit_logs');
  });

  it('write-side beneficiary helper: beneficiary_organization_archived (DETAIL beneficiary=%s) after not_active', () => {
    const body = fn('_phoenix_central_needs_assert_beneficiary_v1');
    const inactive = at(body, "'beneficiary_organization_not_active'", 'not_active');
    const archived = at(body, "'beneficiary_organization_archived'", 'archived');
    expect(inactive).toBeLessThan(archived);
    const r = raiseOf(body, 'beneficiary_organization_archived');
    expect(r).toContain("ERRCODE = '23514'");
    expect(r).toContain("'beneficiary=%s'");
    expect(body).toContain('archived_at');
    for (const code of ['beneficiary_organization_required', 'beneficiary_organization_not_found', 'beneficiary_must_be_care_institution',
      'target_warehouse_not_found', 'target_warehouse_not_owned_by_beneficiary', 'target_warehouse_not_active']) {
      expect(body, code).toContain(`'${code}'`);
    }
  });

  it('blockers: the 18 M216 branches in order, then exactly the two C5 codes appended last', () => {
    const body = fn('_phoenix_central_needs_review_blockers_v1');
    const codes = [...body.matchAll(/SELECT\s+'(\w+)'(?:::text)?\s*,/g)].map((m) => m[1]);
    const m216 = [...fn('_phoenix_central_needs_review_blockers_v1', M216).matchAll(/SELECT\s+'(\w+)'(?:::text)?\s*,/g)].map((m) => m[1]);
    expect(m216).toHaveLength(18);
    expect(codes).toEqual([...m216, 'source_cell_value_contract_invalid', 'need_line_quantity_lineage_unsafe']);
    expect(body).toMatch(/'session=%s source_record=%s reason=(?:invalid_evidence|%s)'/);
    expect(body).toContain("'session=%s source_record=%s need_line=%s reason=%s'");
    expect(body).toContain(`public.${LINEAGE}(`);
    const tail = body.slice(body.indexOf("'source_cell_value_contract_invalid'"));
    expect(tail).toContain("'draft'");
    expect(tail).toMatch(/status\s*=\s*'completed'/);
  });

  it('blockers: the four A1 branches use the classifier candidate predicate; no valueType literal survives', () => {
    const body = fn('_phoenix_central_needs_review_blockers_v1');
    expect(body).not.toMatch(/valueType'\s*=\s*'number'/);
    expect((body.match(new RegExp(CLASSIFIER, 'g')) ?? []).length).toBeGreaterThanOrEqual(5);
    for (const c of CANDIDATES) expect((body.match(new RegExp(`'${c}'`, 'g')) ?? []).length, c).toBeGreaterThanOrEqual(4);
  });

  it('blockers: warehouse/beneficiary branches carry reason tokens; archived now blocks', () => {
    const body = fn('_phoenix_central_needs_review_blockers_v1');
    expect(body).toMatch(/'need_line=%s warehouse=%s reason=(?:not_owned|%s)'/);
    expect(body).toMatch(/'need_line=%s warehouse=%s status=%s reason=(?:not_active|%s)'/);
    expect(body).toContain("'need_line=%s beneficiary=%s reason=%s'");
    for (const r of ['not_care_institution', 'inactive', 'archived']) expect(body, r).toContain(`'${r}'`);
    expect(body).toMatch(/archived_at IS NOT NULL/);
  });

  it('list: same 17 columns, SECURITY INVOKER; native counts native-only and CASE-guarded; review via candidates', () => {
    const body = fn('phoenix_central_needs_list_beneficiary_columns');
    expect(header(SQL, 'phoenix_central_needs_list_beneficiary_columns').returns)
      .toBe(header(M216, 'phoenix_central_needs_list_beneficiary_columns').returns);
    expect(body).not.toMatch(/valueType'\s*=\s*'number'/);
    expect(body).toContain(`public.${CLASSIFIER}(`);
    expect(body).not.toContain(LINEAGE);
    for (const c of CANDIDATES) expect(body, c).toContain(`'${c}'`);
    // Every numeric cast of a cell value sits inside a CASE (never evaluated for a non-native cell).
    const casts = [...body.matchAll(/->>?'value'\)::numeric/g)].map((m) => m.index ?? 0);
    for (const i of casts) {
      const before = body.slice(0, i);
      expect(before.lastIndexOf('CASE'), 'cast inside CASE').toBeGreaterThan(before.lastIndexOf(' END'));
    }
  });

  it('override RPC: head = created_at DESC, id DESC; explicit strictly-increasing created_at; unchanged return keys', () => {
    const body = fn('phoenix_central_needs_record_field_override');
    expect(body).toMatch(/ORDER BY\s+(?:\w+\.)?created_at\s+DESC\s*,\s*(?:\w+\.)?id\s+DESC/);
    expect(body).toMatch(/GREATEST\s*\(\s*clock_timestamp\(\)/);
    expect(body).toContain("interval '1 microsecond'");
    const insert = body.slice(at(body, 'INSERT INTO public.central_needs_field_overrides', 'override insert'));
    expect(insert.slice(0, insert.indexOf(')'))).toContain('created_at');
    for (const key of ['ok', 'override_id', 'source_record_id', 'record_ordinal', 'target_entity', 'field_name', 'previous_value', 'final_value']) {
      expect(body, key).toContain(`'${key}'`);
    }
    // The load of the revision FOR UPDATE precedes the head read.
    expect(at(body, '_phoenix_central_needs_load_revision_v1', 'revision lock')).toBeLessThan(at(body, /ORDER BY\s+(?:\w+\.)?created_at\s+DESC/, 'head'));
  });

  it('approval fence body: INSERT or UPDATE into approved, exact same-transaction gate, 23514 with DETAIL revision=%s', () => {
    const body = fn(FENCE);
    expect(body).toMatch(/TG_OP\s*(?:=|<>|IS DISTINCT FROM)\s*'(?:INSERT|UPDATE)'/);
    expect(body).toMatch(/OLD\.status\s+IS\s+(?:NOT\s+)?DISTINCT\s+FROM\s+'approved'/);
    expect(body).toMatch(/NEW\.status\s*(?:=|IS NOT DISTINCT FROM)\s*'approved'/);
    for (const needle of ["'central_needs.plan_revision.approval_gate'", "'central_needs_plan_revision'", "'c5-v1'",
      'txid_current()', 'auth.uid()', "'contract'", "'txid'", 'NEW.id', 'NEW.organization_id', 'created_at']) {
      expect(body, needle).toContain(needle);
    }
    expect(body).toMatch(/transaction_timestamp\(\)|\bnow\(\)/);
    const r = raiseOf(body, 'central_needs_approval_gate_missing');
    expect(r).toContain("ERRCODE = '23514'");
    expect(r).toMatch(/DETAIL = format\('revision=%s', NEW\.id\)/);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(?:INTO|public\.|FROM)/);
  });

  it('approve: frozen step order — guard, owner FOR SHARE, family lock, A-E, beneficiary/warehouse FOR SHARE, A2, gate, mutations', () => {
    const body = fn('phoenix_central_needs_approve_revision');
    const steps: Array<[string | RegExp, string]> = [
      ["'not_authenticated'", 'auth.uid'],
      ["'plan_revision_id_required'", 'id required'],
      ["'plan_revision_not_found'", 'unlocked read'],
      ["_phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.approve')", 'guard'],
      [/FROM public\.organizations[^;]*FOR SHARE/, 'owner FOR SHARE'],
      ['_phoenix_central_needs_lock_plan_family_v1', 'family lock'],
      ["'idempotent_replay', true", 'A idempotent'],
      ["'plan_revision_not_submitted'", 'B not submitted'],
      ['is not the newest revision of plan=%s', 'C newest'],
      ["'plan=%s holds %s approved revisions'", 'D ambiguity'],
      [/FROM public\.organizations o\b[^;]*ORDER BY o\.id\s+FOR SHARE\s*;/, 'beneficiaries FOR SHARE ORDER BY o.id'],
      [/FROM public\.warehouses w\b[^;]*ORDER BY w\.id\s+FOR SHARE\s*;/, 'warehouses FOR SHARE ORDER BY w.id'],
      ["'central_needs_approval_eligibility_changed'", 'A2'],
      ["'central_needs.plan_revision.approval_gate'", 'gate audit'],
      [/SET\s+status\s*=\s*'superseded'/, 'supersede'],
      [/SET\s+status\s*=\s*'approved'/, 'approve'],
      ["'central_needs.plan_revision.supersede'", 'supersede audit'],
      ["'central_needs.plan_revision.approve'", 'approve audit'],
      ['RETURN jsonb_build_object(', 'return'],
    ];
    let last = -1;
    for (const [needle, label] of steps) {
      const rest = body.slice(last + 1);
      const i = typeof needle === 'string' ? rest.indexOf(needle) : rest.search(needle);
      expect(i, `${label} after the previous step`).toBeGreaterThanOrEqual(0);
      last += 1 + i;
    }
    // No predecessor mutation before A2 passes and the gate is written.
    const firstWrite = body.search(/UPDATE\s+public\.central_needs_plan_revisions/);
    expect(firstWrite).toBeGreaterThan(body.indexOf("'central_needs.plan_revision.approval_gate'"));
    const gateStatement = body.lastIndexOf('INSERT INTO public.audit_logs', body.indexOf("'central_needs.plan_revision.approval_gate'"));
    expect(body.slice(0, gateStatement)).not.toMatch(/INSERT\s+INTO|UPDATE\s+public\./);
  });

  it('approve: the A2 lock set is exactly this revision\'s beneficiaries then its non-null warehouses, each ascending by id, one statement each', () => {
    // A regression to ORDER BY o.name (or to no ordering while another
    // ORDER BY id stays in the body) would re-open the multi-row deadlock the
    // ratified order closes; the key and the scope are pinned exactly.
    const body = tight(fn('phoenix_central_needs_approve_revision'));
    const beneficiaries = 'PERFORM 1 FROM public.organizations o WHERE o.id IN (SELECT n.beneficiary_organization_id '
      + 'FROM public.central_needs_need_lines n WHERE n.plan_revision_id = p_plan_revision_id) ORDER BY o.id FOR SHARE;';
    const warehouses = 'PERFORM 1 FROM public.warehouses w WHERE w.id IN (SELECT n.target_warehouse_id '
      + 'FROM public.central_needs_need_lines n WHERE n.plan_revision_id = p_plan_revision_id AND n.target_warehouse_id IS NOT NULL) '
      + 'ORDER BY w.id FOR SHARE;';
    expect(body.split(beneficiaries)).toHaveLength(2);
    expect(body.split(warehouses)).toHaveLength(2);
    expect(body.indexOf(beneficiaries)).toBeLessThan(body.indexOf(warehouses));
    // The owner lock is the only other explicit row lock, and it is on the owner id alone.
    const rowLocks = [...body.matchAll(/FOR (?:NO KEY UPDATE|UPDATE|KEY SHARE|SHARE)\b[^;]*;/g)].length;
    expect(rowLocks).toBe(3);
    expect(body).toContain('PERFORM 1 FROM public.organizations WHERE id = v_revision.organization_id FOR SHARE;');
    // A2 reads the locked rows only after both lock statements.
    expect(body.indexOf(warehouses)).toBeLessThan(body.indexOf('FOR v_line IN SELECT n.id, n.beneficiary_organization_id, n.target_warehouse_id'));
  });

  it('no M217 function translates a lock, deadlock, cancel or serialization error (no catch-all EXCEPTION handler anywhere)', () => {
    // §4: 40P01/55P03/57014/40001 are never translated. Narrow handlers for a
    // specific data condition (unique_violation, invalid_text_representation)
    // are allowed; OTHERS and every lock/cancel/serialization condition are not.
    const forbidden = new RegExp(
      '\\bWHEN\\s+(?:\\w+\\s+OR\\s+)*(?:OTHERS|lock_not_available|deadlock_detected|query_canceled|serialization_failure|'
      + 'transaction_rollback|statement_completion_unknown|SQLSTATE\\s+\'(?:40\\w{3}|55P03|57014)\')\\b', 'i');
    for (const name of [...NEW_FUNCTIONS, ...Object.keys(REPLACED)]) {
      const body = fn(name);
      expect(body, name).not.toMatch(forbidden);
      for (const m of body.matchAll(/\bEXCEPTION\s+WHEN\s+([\w\s]+?)\s+THEN\b/gi)) {
        expect(['unique_violation', 'invalid_text_representation'], `${name}: EXCEPTION WHEN ${m[1]}`).toContain(m[1].trim());
      }
    }
    expect(fn('phoenix_central_needs_approve_revision')).not.toMatch(/\bEXCEPTION\s+WHEN\b/);
    // Nor do the migration-time DO blocks swallow anything.
    expect(outsideFunctionBodies(EXEC)).not.toMatch(/\bEXCEPTION\s+WHEN\b/i);
  });

  it('approve: A2 vocabulary, gate payload, approval_gate_txid, no exception handler, no blockers call', () => {
    const body = fn('phoenix_central_needs_approve_revision');
    expect(body).toMatch(/'blocker=%s need_line=%s beneficiary=%s/);
    expect(body).toContain('reason=%s');
    for (const code of ['need_line_beneficiary_ineligible', 'need_line_warehouse_org_mismatch', 'need_line_target_warehouse_not_active',
      'not_found', 'not_care_institution', 'inactive', 'archived', 'not_owned', 'not_active']) {
      expect(body, code).toMatch(new RegExp(`['=]${code}[' ]`));
    }
    expect(body).toMatch(/ORDER BY\s+(?:\w+\.)?id\b/);
    const gateAt = body.indexOf("'central_needs.plan_revision.approval_gate'");
    const gateInsert = body.slice(body.lastIndexOf('INSERT INTO public.audit_logs', gateAt), gateAt);
    expect(gateInsert, 'the gate INSERT leaves created_at to its default (transaction timestamp)').not.toContain('created_at');
    const gatePayload = body.slice(gateAt, body.indexOf(');', gateAt));
    expect(gatePayload).toMatch(/'contract',\s*'c5-v1'/);
    expect(gatePayload).toMatch(/'txid',\s*txid_current\(\)::text/);
    const approveAudit = body.slice(body.indexOf("'central_needs.plan_revision.approve'"));
    expect(approveAudit).toMatch(/'approval_gate_txid',\s*txid_current\(\)::text/);
    expect(body).not.toMatch(/\bEXCEPTION\s+WHEN\b/);
    expect(body).not.toContain('_phoenix_central_needs_review_blockers_v1');
    // M215 VERIFY needles stay in the body.
    expect(body).toContain('_phoenix_central_needs_lock_plan_family_v1');
    expect(body).toContain("'superseded'");
  });
});

guard('C5/M217 static — VERIFY', () => {
  it('is last, catalog-only (no DML), and asserts the C5 objects, their grants and audit_logs privileges', () => {
    expect(VERIFY_AT).toBeGreaterThan(CODE.search(/CREATE\s+TRIGGER\s+central_needs_plan_revisions_c5_approval_gate/));
    expect(VERIFY_AT).toBeGreaterThan(CODE.lastIndexOf('CREATE OR REPLACE FUNCTION'));
    expect(VERIFY_AT).toBeGreaterThan(CODE.search(/ALTER\s+TABLE\s+public\.central_needs_source_records/));
    for (const needle of [
      'VERIFY FAILED (217)', CLASSIFIER, LINEAGE, FENCE, 'central_needs_plan_revisions_c5_approval_gate',
      'central_needs_source_records_c5_value_contract', 'convalidated', 'audit_logs',
    ]) {
      expect(VERIFY, needle).toContain(needle);
    }
    expect(VERIFY).toMatch(/has_(?:table|any_column|column)_privilege/);
    expect(VERIFY).toMatch(/has_function_privilege/);
    // Pure classifier probes: at least one output token is asserted behaviourally.
    expect(CANDIDATES.some((c) => VERIFY.includes(`'${c}'`))).toBe(true);
    const verifyExec = executableSql(VERIFY);
    expect(verifyExec).not.toMatch(/\bINSERT\s+INTO\b|\bUPDATE\s+\w+(?:\.\w+)?\s+SET\b|\bDELETE\s+FROM\b/i);
    expect(verifyExec).not.toMatch(/\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b|\bFOR\s+(?:KEY\s+)?SHARE\b/i);
  });

  it('self-checks the §1 lock budget from pg_locks of its OWN backend, after every lock-taking step, with the three frozen refusals', () => {
    // Contract §1: "Before COMMIT, pg_locks evidence scoped to Phoenix
    // application relations proves the budget." The check must read this
    // backend's locks (not a rig probe), key on the frozen modes, and fail.
    const V = tight(VERIFY);
    const BUDGET = "'VERIFY FAILED (217): % Phoenix relation lock(s) outside the §1 budget'";
    const PAIR = "'VERIFY FAILED (217): the §1 activation lock pair is not held'";
    const ROWLOCK = "'VERIFY FAILED (217): an advisory or tuple lock is held'";
    const budgetAt = at(V, BUDGET, 'budget refusal');
    const pairAt = at(V, PAIR, 'lock-pair refusal');
    const rowAt = at(V, ROWLOCK, 'advisory/tuple refusal');
    for (const msg of [BUDGET, PAIR, ROWLOCK]) expect(V.split(msg), msg).toHaveLength(2);

    // 1. Budget: every relation lock of this backend on a public relation is
    //    ACCESS SHARE, except source_records ACCESS EXCLUSIVE and plan_revisions
    //    EXCLUSIVE / SHARE ROW EXCLUSIVE (the one CREATE TRIGGER).
    const budget = V.slice(V.lastIndexOf('SELECT count(*) INTO n FROM pg_locks', budgetAt), budgetAt);
    expect(budget).toMatch(/^SELECT count\(\*\) INTO n FROM pg_locks l JOIN pg_class c ON c\.oid = l\.relation JOIN pg_namespace ns ON ns\.oid = c\.relnamespace WHERE /);
    for (const needle of [
      'l.pid = pg_backend_pid()', "l.locktype = 'relation'", "ns.nspname = 'public'", "l.mode <> 'AccessShareLock'",
      "AND NOT (c.relname = 'central_needs_source_records' AND l.mode = 'AccessExclusiveLock')",
      "AND NOT (c.relname = 'central_needs_plan_revisions' AND l.mode IN ('ExclusiveLock', 'ShareRowExclusiveLock'));",
      'IF n > 0 THEN RAISE EXCEPTION',
    ]) {
      expect(budget, needle).toContain(needle);
    }
    // No other exemption: exactly the two NOT (...) carve-outs.
    expect(budget.match(/AND NOT \(/g)).toHaveLength(2);

    // 2. The pair itself is held, in exactly the frozen modes.
    const pair = V.slice(budgetAt, pairAt);
    expect(pair).toContain("l.relation = 'public.central_needs_source_records'::regclass AND l.mode = 'AccessExclusiveLock'");
    expect(pair).toContain("l.relation = 'public.central_needs_plan_revisions'::regclass AND l.mode = 'ExclusiveLock'");
    expect((pair.match(/l\.pid = pg_backend_pid\(\)/g) ?? []).length).toBe(2);

    // 3. No advisory and no tuple lock of this backend.
    const rows = V.slice(pairAt, rowAt);
    expect(rows).toContain("l.pid = pg_backend_pid() AND l.locktype IN ('advisory', 'tuple')");

    // Order: budget, pair, advisory/tuple — and all of it AFTER the last step
    // of VERIFY that reads an application table (the status fingerprint), so
    // the self-check sees every lock the migration took.
    expect(budgetAt).toBeLessThan(pairAt);
    expect(pairAt).toBeLessThan(rowAt);
    const lastAppRead = V.lastIndexOf('FROM public.central_needs_plan_revisions');
    expect(lastAppRead).toBeGreaterThan(0);
    expect(V.indexOf('FROM pg_locks')).toBeGreaterThan(lastAppRead);
    // Nothing after the self-check touches a public relation (only the pure classifier probes).
    const afterSelfCheck = VERIFY.indexOf(ROWLOCK);
    expect(afterSelfCheck).toBeGreaterThan(0);
    expect(executableSql(VERIFY.slice(afterSelfCheck + ROWLOCK.length))).not.toMatch(/\bFROM\s+public\./i);
  });
});
