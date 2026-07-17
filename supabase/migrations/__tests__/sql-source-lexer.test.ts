/**
 * SQL-SOURCE-LEXER-A — tests for the shared migration-SQL lexer.
 *
 * This module is what every migration guard's honesty rests on: if it strips the
 * wrong thing, or silently strips nothing, the guards keep passing while proving
 * nothing. So it gets its own tests rather than being trusted implicitly.
 *
 * The two regressions that motivated it are pinned first and explicitly:
 *   - CRLF sources must behave EXACTLY like LF sources.
 *   - `--` inside a single-quoted string is data, not a comment.
 *
 * Every case here is an in-memory string. No file is read and no migration is
 * touched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  activeSql,
  executableSql,
  normalizeSql,
  normalizedActiveSql,
  sqlFunctionSource,
  stripSqlComments,
} from './helpers/sql-source';

/** Convert an LF fixture to its CRLF twin. */
const crlf = (s: string): string => s.replace(/\n/g, '\r\n');

// ============================================================================
// 1. Line endings — the regression that made the old guards inert on Windows
// ============================================================================

describe('1. LF and CRLF are treated identically', () => {
  const src = `select 1; -- a trailing comment\nselect 2;\n`;

  it('strips a comment from an LF source', () => {
    expect(stripSqlComments(src)).toBe('select 1; \nselect 2;\n');
  });

  it('strips a comment from a CRLF source', () => {
    // The old /--.*$/ stripped NOTHING here: '.' does not match '\r', so '$'
    // never anchored. This is the exact bug being pinned.
    expect(stripSqlComments(crlf(src))).toBe('select 1; \r\nselect 2;\r\n');
  });

  it('produces identical normalized output for LF and CRLF', () => {
    expect(normalizedActiveSql(crlf(src))).toBe(normalizedActiveSql(src));
  });

  it('removes the CR that belongs to a stripped comment', () => {
    // The comment and its '\r' go; the '\n' stays, so line structure survives.
    expect(stripSqlComments('a; -- c\r\nb;')).toBe('a; \r\nb;');
  });

  it('strips a whole-line comment under both line endings', () => {
    expect(normalizedActiveSql('-- only a comment\nselect 1;')).toBe('select 1;');
    expect(normalizedActiveSql(crlf('-- only a comment\nselect 1;'))).toBe('select 1;');
  });

  it('handles a comment on the final line with no trailing newline', () => {
    expect(stripSqlComments('select 1; -- end')).toBe('select 1; ');
    expect(stripSqlComments('select 1; -- end\r')).toBe('select 1; \r');
  });

  it('leaves a source with no comments untouched, LF or CRLF', () => {
    const plain = 'select 1;\nselect 2;\n';
    expect(stripSqlComments(plain)).toBe(plain);
    expect(stripSqlComments(crlf(plain))).toBe(crlf(plain));
  });
});

// ============================================================================
// 2. `--` inside a single-quoted string is DATA, not a comment
// ============================================================================

describe('2. comment markers inside string literals survive', () => {
  it("keeps a literal '--' intact", () => {
    // Migration 067's placeholder CHECK genuinely contains these literals.
    const src = "check (code not in ('-', '--'));";
    expect(stripSqlComments(src)).toBe(src);
  });

  it('does not truncate the line that contains a quoted --', () => {
    const src = "check (upper(btrim(x)) not in ('N/A', '-', '--') and y = 1); -- gone\n";
    expect(stripSqlComments(src)).toBe(
      "check (upper(btrim(x)) not in ('N/A', '-', '--') and y = 1); \n",
    );
  });

  it('keeps quote balance across a line holding a quoted --', () => {
    // The old regex truncated mid-literal, leaving an odd number of quotes,
    // which then mis-paired every literal in the rest of the file.
    const src = "insert into t values ('--');\ninsert into u values ('kept');\n";
    expect(executableSql(src)).toBe("insert into t values ('');\ninsert into u values ('');\n");
  });

  it('treats -- inside a longer literal as data', () => {
    expect(stripSqlComments("select 'a -- b' as x;")).toBe("select 'a -- b' as x;");
  });

  it('still strips a real comment that follows a quoted --', () => {
    expect(stripSqlComments("select '--' ; -- real comment\n")).toBe("select '--' ; \n");
  });

  it('handles a literal that is only a comment marker, at end of input', () => {
    expect(stripSqlComments("select '--'")).toBe("select '--'");
  });
});

// ============================================================================
// 3. Escaped quotes
// ============================================================================

describe("3. '' escaped quotes do not end a literal", () => {
  it('keeps an escaped quote inside a literal', () => {
    const src = "comment on table t is 'the outlet''s stock';";
    expect(stripSqlComments(src)).toBe(src);
  });

  it('does not mistake the char after an escaped quote for code', () => {
    const src = "select 'it''s -- not a comment' as x; -- but this is\n";
    expect(stripSqlComments(src)).toBe("select 'it''s -- not a comment' as x; \n");
  });

  it('blanks a literal containing escaped quotes as one literal', () => {
    expect(executableSql("select 'a''b''c';")).toBe("select '';");
  });

  it('handles a literal that is exactly an escaped quote', () => {
    expect(stripSqlComments("select '''';")).toBe("select '''';");
    expect(executableSql("select '''';")).toBe("select '';");
  });

  it('handles consecutive literals without merging them', () => {
    expect(executableSql("values ('a', 'b');")).toBe("values ('', '');");
  });

  it('survives an unterminated literal without hanging or throwing', () => {
    // Malformed input must degrade, never loop forever.
    expect(() => stripSqlComments("select 'unterminated")).not.toThrow();
    expect(stripSqlComments("select 'unterminated")).toBe("select 'unterminated");
  });
});

// ============================================================================
// 4. Dollar-quoted bodies
// ============================================================================

describe('4. dollar-quoted bodies are scanned, and their tags bound string state', () => {
  it('strips comments INSIDE a $$ body', () => {
    // Deliberate: every RPC lives in a $$ body, and the guards must be able to
    // prove things about that body's code, not its prose.
    const src = `create function f() returns int language plpgsql as $$\nbegin\n  -- prose\n  return 1;\nend;\n$$;`;
    expect(stripSqlComments(src)).not.toContain('prose');
    expect(stripSqlComments(src)).toContain('return 1;');
  });

  it('keeps the dollar tags themselves', () => {
    const src = `as $$ select 1; $$;`;
    expect(stripSqlComments(src)).toBe(src);
  });

  it('honours single-quoted strings inside a $$ body', () => {
    const src = `as $$ begin raise exception 'a -- b'; end; $$;`;
    expect(stripSqlComments(src)).toBe(src);
  });

  it('supports named tags like $guard$ and $verify$', () => {
    const src = `do $guard$\nbegin\n  -- gone\n  raise notice 'kept';\nend;\n$guard$;`;
    const out = stripSqlComments(src);
    expect(out).not.toContain('gone');
    expect(out).toContain("raise notice 'kept';");
    expect(out).toContain('$guard$');
  });

  it('does not let one body\'s unbalanced apostrophe corrupt the next', () => {
    // This is why the tag is tracked at all. The apostrophe in "outlet's" sits
    // in a comment inside the first body; the second body must lex cleanly.
    const src = [
      `do $a$ begin -- the outlet's stock`,
      `  raise notice 'one';`,
      `end; $a$;`,
      `do $b$ begin`,
      `  raise notice 'two';`,
      `end; $b$;`,
    ].join('\n');
    const out = stripSqlComments(src);
    expect(out).toContain("raise notice 'one';");
    expect(out).toContain("raise notice 'two';");
    expect(out).not.toContain('outlet');
  });

  it('treats a $$ inside a string literal as data, not a tag', () => {
    const src = `select '$$' as x; -- gone\n`;
    expect(stripSqlComments(src)).toBe(`select '$$' as x; \n`);
  });

  it('handles adjacent bodies with the same tag', () => {
    const src = `as $$ select 1; $$; as $$ select 2; $$;`;
    expect(stripSqlComments(src)).toBe(src);
  });

  it('does not treat a positional parameter like $1 as a tag', () => {
    const src = `execute 'x' using $1; -- gone\n`;
    expect(stripSqlComments(src)).toBe(`execute 'x' using $1; \n`);
  });

  it('works under CRLF inside a body too', () => {
    const src = `do $x$\nbegin\n  -- gone\n  return;\nend;\n$x$;`;
    expect(normalizedActiveSql(crlf(src))).toBe(normalizedActiveSql(src));
    expect(normalizedActiveSql(crlf(src))).not.toContain('gone');
  });
});

// ============================================================================
// 5. executableSql — prose can never satisfy a check
// ============================================================================

describe('5. executableSql blanks literals so RAISE prose cannot match', () => {
  it('blanks a RAISE message', () => {
    const src = `raise exception 'we never revoke anything';`;
    expect(executableSql(src)).toBe(`raise exception '';`);
    expect(executableSql(src)).not.toContain('revoke');
  });

  it('removes comment prose as well as literal prose', () => {
    const src = `-- this migration does not drop anything\nselect 1;`;
    expect(executableSql(src)).not.toContain('drop');
  });

  it('keeps real executable keywords', () => {
    const src = `drop table t; -- comment saying nothing\n`;
    expect(executableSql(src)).toContain('drop table t;');
  });

  it('lets a negative assertion be trusted: prose mentioning REVOKE does not match', () => {
    const src = `-- No REVOKE of any kind here.\ncomment on table t is 'we do not revoke';\nselect 1;`;
    expect(/revoke/i.test(executableSql(src))).toBe(false);
  });

  it('still catches a genuine REVOKE', () => {
    const src = `-- prose\nrevoke all on table t from anon;`;
    expect(/revoke/i.test(executableSql(src))).toBe(true);
  });
});

// ============================================================================
// 6. normalizeSql
// ============================================================================

describe('6. normalizeSql collapses whitespace deterministically', () => {
  it('collapses runs of spaces, tabs and newlines to one space', () => {
    expect(normalizeSql('a\n\n\tb   c')).toBe('a b c');
  });

  it('trims the ends', () => {
    expect(normalizeSql('  a  ')).toBe('a');
  });

  it('is line-ending agnostic', () => {
    expect(normalizeSql('a\r\nb')).toBe(normalizeSql('a\nb'));
  });
});

// ============================================================================
// 7. sqlFunctionSource
// ============================================================================

describe('7. sqlFunctionSource is bounded by its own terminator', () => {
  const two = [
    `CREATE OR REPLACE FUNCTION public.f_one(p int)`,
    `RETURNS int LANGUAGE plpgsql AS $$`,
    `BEGIN RETURN 1; END;`,
    `$$;`,
    `CREATE OR REPLACE FUNCTION public.f_two(p int)`,
    `RETURNS int LANGUAGE plpgsql AS $$`,
    `BEGIN RETURN 2; END;`,
    `$$;`,
    `GRANT EXECUTE ON FUNCTION public.f_two(int) TO authenticated;`,
  ].join('\n');

  it('returns only the named function', () => {
    const one = sqlFunctionSource(two, 'f_one')!;
    expect(one).toContain('RETURN 1;');
    expect(one).not.toContain('RETURN 2;');
  });

  it('does not swallow what follows the LAST function', () => {
    // The whole reason this helper is not "slice to the next CREATE FUNCTION".
    const last = sqlFunctionSource(two, 'f_two')!;
    expect(last).toContain('RETURN 2;');
    expect(last).not.toContain('GRANT EXECUTE');
  });

  it('returns null for an absent function rather than an empty string', () => {
    expect(sqlFunctionSource(two, 'f_missing')).toBeNull();
  });

  it('strips comments within the returned body', () => {
    const src = `CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$\n-- secret prose\nSELECT 1;\n$$;`;
    const body = sqlFunctionSource(src, 'f')!;
    expect(body).not.toContain('secret prose');
    expect(body).toContain('SELECT 1;');
  });

  it('matches CREATE FUNCTION as well as CREATE OR REPLACE FUNCTION', () => {
    const src = `CREATE FUNCTION public.g() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;`;
    expect(sqlFunctionSource(src, 'g')).toContain('SELECT 1;');
  });

  it('supports a named dollar tag', () => {
    const src = `CREATE FUNCTION public.h() RETURNS int LANGUAGE plpgsql AS $body$\nBEGIN RETURN 1; END;\n$body$;`;
    const body = sqlFunctionSource(src, 'h')!;
    expect(body).toContain('RETURN 1;');
    expect(body.endsWith('$body$')).toBe(true);
  });

  it('works under CRLF', () => {
    expect(normalizeSql(sqlFunctionSource(crlf(two), 'f_one')!)).toBe(
      normalizeSql(sqlFunctionSource(two, 'f_one')!),
    );
  });
});

// ============================================================================
// 8. Applied to the real migrations — the lexer must actually bite
// ============================================================================

describe('8. the lexer does real work on the real migration sources', () => {
  const read = (f: string): string =>
    readFileSync(join(__dirname, '../', f), 'utf8');

  it('067: the quoted -- placeholder literals survive', () => {
    const active = activeSql(read('067_phoenix_outlet_stock_expand.sql'));
    expect(active).toContain("'--'");
  });

  it('067: header prose is gone from the active SQL', () => {
    const active = activeSql(read('067_phoenix_outlet_stock_expand.sql'));
    expect(active).not.toContain('MANUAL APPLY ONLY');
    expect(active).toContain('CREATE TABLE IF NOT EXISTS public.outlet_stock');
  });

  it('066: prose mentioning parent_warehouse_id is stripped', () => {
    // The exact assertion that was failing on Windows before this lexer existed.
    const active = activeSql(read('066_phoenix_inventory_network_expand.sql'));
    expect(/parent_warehouse_id/i.test(active)).toBe(false);
  });

  it('066: prose mentioning REVOKE does not survive into executable SQL', () => {
    const exec = executableSql(read('066_phoenix_inventory_network_expand.sql'));
    expect(/(REVOKE|GRANT)[^;]*phoenix_upsert_availability/i.test(exec)).toBe(false);
  });

  it('066: real statements do survive', () => {
    const exec = executableSql(read('066_phoenix_inventory_network_expand.sql'));
    expect([...exec.matchAll(/INSERT INTO[^;]*;/gi)].length).toBeGreaterThan(0);
  });

  it('060/061: the quoted placeholder literals survive lexing', () => {
    for (const f of [
      '060_phoenix_warehouse_foundation.sql',
      '061_phoenix_warehouse_dispatch_schema.sql',
    ]) {
      expect(activeSql(read(f)), f).toContain("'--'");
    }
  });
});
