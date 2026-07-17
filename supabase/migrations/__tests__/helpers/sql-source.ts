/**
 * SQL-SOURCE-LEXER-A — the single lexical reader for migration SQL (test-only).
 *
 * Migration guard tests work by asserting against the migration's EXECUTABLE
 * SQL: prose in a `--` comment must never be able to satisfy a check, and a
 * string literal inside a RAISE message must never be able to either. Those
 * guards are only as trustworthy as the code that separates comment from
 * command — so that separation is done here, once, lexically.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS — the bug it replaces
 * ─────────────────────────────────────────────────────────────────────────────
 * Migrations 059–067's tests each carried their own copy of:
 *
 *     sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
 *
 * which is wrong in two independent ways, and silently so:
 *
 *  1. CRLF. After split('\n') each line still ends with '\r'. In JavaScript `.`
 *     does not match '\r', and `$` without the /m flag only matches end-of-
 *     string — so on any CRLF checkout the pattern never matches and NOT ONE
 *     comment is stripped. Every assertion then runs against raw prose. This
 *     repo has no .gitattributes and Windows clones default to
 *     core.autocrlf=true, so the guards were inert on Windows while passing on
 *     the Linux CI runner. That divergence is exactly what a guard must not have.
 *
 *  2. Comment markers inside string literals. Migration 067's placeholder CHECK
 *     rejects the literals '-' and '--'. A per-line regex truncates that line
 *     mid-literal, leaving an unbalanced quote, which then corrupts the
 *     literal-blanking pass for the whole rest of the file.
 *
 * Both failures are silent: they do not throw, they just quietly make the tests
 * agree with you. Hence a scanner, not a regex.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DELIBERATE SEMANTIC CHOICE: dollar-quoted bodies
 * ─────────────────────────────────────────────────────────────────────────────
 * PostgreSQL treats $$...$$ as an opaque string literal. This lexer does NOT:
 * inside a dollar-quoted region it keeps scanning, stripping comments and
 * honouring single-quoted strings.
 *
 * That is intentional and is the only useful reading here. Every RPC in 060–067
 * lives inside a $$ body, and the guards must be able to prove things about that
 * body's CODE without its own `--` prose satisfying the check. Treating the body
 * as opaque text would make those assertions meaningless.
 *
 * The dollar TAG is still tracked, and that is load-bearing: it bounds string
 * state, so an unbalanced apostrophe inside one function body (`-- the outlet's
 * stock`) cannot bleed out and mis-lex the rest of the file.
 *
 * Read-only: this module touches no filesystem and imports no production code.
 */

/** Matches a dollar-quote delimiter at a position: `$$` or `$tag$`. */
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

interface ScanOptions {
  /** Remove `--` line comments (never inside a single-quoted string). */
  stripComments: boolean;
  /** Replace every single-quoted literal's contents with an empty literal. */
  blankStrings: boolean;
}

/**
 * The one scanner. Walks the source once, tracking three things: whether we are
 * inside a single-quoted string, which dollar tag (if any) is open, and nothing
 * else. Everything else in this module is a thin wrapper over it.
 */
function scan(sql: string, opts: ScanOptions): string {
  let out = '';
  let i = 0;
  let dollarTag: string | null = null;

  while (i < sql.length) {
    // 1. Dollar-quote boundaries. Checked first so a tag is never mistaken for
    //    ordinary text, and so string state is bounded by the body it is in.
    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) {
        out += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
    } else {
      const open = DOLLAR_TAG.exec(sql.slice(i));
      if (open) {
        out += open[0];
        i += open[0].length;
        dollarTag = open[0];
        continue;
      }
    }

    const c = sql[i];

    // 2. Single-quoted string literal. Consumed whole, so a `--`, a newline or a
    //    dollar sign inside it is never interpreted as anything else.
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2; // '' is an escaped quote, not a terminator
            continue;
          }
          j++; // closing quote
          break;
        }
        j++;
      }
      out += opts.blankStrings ? "''" : sql.slice(i, j);
      i = j;
      continue;
    }

    // 3. Line comment. Runs to the line terminator but never consumes it —
    //    stopping at '\r' as well as '\n' keeps the source's own line endings
    //    intact, so a CRLF file strips to CRLF and an LF file strips to LF.
    if (opts.stripComments && c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      continue; // the terminator itself is emitted by the next iteration
    }

    out += c;
    i++;
  }

  return out;
}

/**
 * The migration's SQL with `--` comments removed and every literal preserved.
 *
 * Handles LF and CRLF identically. A `--` inside a single-quoted string is data,
 * not a comment, and survives.
 */
export function stripSqlComments(sql: string): string {
  return scan(sql, { stripComments: true, blankStrings: false });
}

/** Drop-in name used by the migration guard tests. */
export const activeSql = stripSqlComments;

/**
 * Executable SQL: comments removed AND string literals blanked to `''`.
 *
 * Use this for NEGATIVE assertions ("067 revokes nothing"), where prose in a
 * RAISE message or a COMMENT ON body would otherwise match and produce a
 * false failure — or worse, a false pass.
 */
export function executableSql(sql: string): string {
  return scan(stripSqlComments(sql), { stripComments: false, blankStrings: true });
}

/** Collapse all whitespace runs to single spaces, for shape assertions. */
export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** Comments stripped, whitespace normalized — the common combination. */
export function normalizedActiveSql(sql: string): string {
  return normalizeSql(stripSqlComments(sql));
}

/**
 * The source of one `CREATE [OR REPLACE] FUNCTION public.<name>(`, up to and
 * including the `$$;`-style terminator of its dollar-quoted body.
 *
 * Bounded by the function's OWN terminator rather than by "the next CREATE
 * FUNCTION": the last function in a file has no next one, so that cheaper rule
 * would silently return the entire rest of the migration and quietly turn an
 * assertion about one function into an assertion about everything after it.
 *
 * Returns null when the function is absent, so callers assert rather than
 * silently scanning an empty string.
 */
export function sqlFunctionSource(sql: string, name: string): string | null {
  const active = stripSqlComments(sql);
  const marker = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`,
  );
  const found = marker.exec(active);
  if (!found) return null;

  const rest = active.slice(found.index);
  // Find the body's opening tag, then its matching close.
  const bodyOpen = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
  if (!bodyOpen) return null;
  const tag = bodyOpen[0];
  const closeAt = rest.indexOf(tag, bodyOpen.index + tag.length);
  if (closeAt === -1) return null;

  return rest.slice(0, closeAt + tag.length);
}
