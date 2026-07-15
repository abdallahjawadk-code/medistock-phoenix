/**
 * MIGRATION-GUARD-DERIVE-B — pure git-status side of migration review (test-only).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * MIGRATION-GUARD-DERIVE-A centralized two churn patterns (tail-inventory
 * arrays and future-ceiling regexes) but missed a third: ~13 historical guards
 * each carried their OWN hard-coded allowlist of tolerated git-status lines for
 * migrations that are authored but not yet committed, e.g.
 *
 *   const ALLOWED_UNTRACKED = new Set([
 *     '?? supabase/migrations/059_phoenix_public_qr_concentration.sql',
 *     'A  supabase/migrations/059_phoenix_public_qr_concentration.sql',
 *     ... one pair per in-flight migration, in every one of 13 files ...
 *   ]);
 *
 * Authoring migration 060 made all 13 fail at once — exactly the churn the
 * previous phase set out to remove. This module finishes that job: the allowed
 * set is now DERIVED from the canonical exact-filename registry, so registering
 * a migration once permits its in-flight git-status entries everywhere.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY MODEL — READ BEFORE EDITING
 * ─────────────────────────────────────────────────────────────────────────────
 * This helper LOOSENS nothing. A git-status line is allowed only when ALL hold:
 *
 *   1. The status is exactly `??` (untracked) or `A ` (staged-add) — the only
 *      two states a brand-new, not-yet-committed reviewed migration can be in.
 *   2. The path is exactly `supabase/migrations/<filename>` — no subdirectory,
 *      no rename arrow, no quoting, nothing outside the migrations directory.
 *   3. `<filename>` is an EXACT member of REVIEWED_MIGRATION_FILES.
 *
 * Everything else is unexpected, and deliberately so:
 *   • A MODIFIED reviewed migration (` M`, `M `, `MM`, `AM`) is REJECTED — being
 *     reviewed permits creating a migration, never editing one afterwards. This
 *     is the property that keeps migrations 001–059 immutable, and it must not
 *     be traded away for convenience.
 *   • A DELETED (` D`, `D `), RENAMED (`R `), COPIED (`C `) or CONFLICTED (`UU`,
 *     `AA`, `DU`, …) migration is REJECTED.
 *   • An unregistered filename is REJECTED regardless of its number — 061 is not
 *     admitted by being "next", and an alternate 060 name is not admitted by 60
 *     being reviewed.
 *
 * Approval is never granted by number, pattern, directory presence, or by the
 * file merely appearing in git status.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CALLERS MUST NOT TRIM
 * ─────────────────────────────────────────────────────────────────────────────
 * Porcelain status codes are two columns wide and the first may be a SPACE
 * (` M` = unstaged modification). Trimming a line turns ` M` into `M`, which is
 * precisely why the old hand-written allowlists had to list both `'M …'` and
 * `'M  …'` variants. Pass RAW porcelain lines: this module parses them
 * strictly and treats a mangled/ambiguous line as unexpected rather than
 * guessing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDING A MIGRATION (unchanged, still one edit)
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Author the migration SQL.
 *   2. Add its exact filename to REVIEWED_MIGRATION_FILES (once).
 *   3. Add that migration's own semantic/security tests.
 *   No historical guard file needs an edit — that is this module's whole point.
 *
 * Pure: no filesystem, no Git, no shell, no environment, no product imports, no
 * mutation. It is handed strings and returns strings.
 */
import { REVIEWED_MIGRATION_FILES, isReviewedMigrationFile } from './reviewed-migrations';

/** The only directory a migration git-status entry may live in. */
export const MIGRATIONS_PATH_PREFIX = 'supabase/migrations/';

/**
 * The only two porcelain statuses a NEW, not-yet-committed reviewed migration
 * can legitimately have: untracked, or staged-add.
 */
export const ALLOWED_NEW_MIGRATION_STATUSES: readonly string[] = Object.freeze(['??', 'A ']);

const ALLOWED_STATUS_SET: ReadonlySet<string> = new Set(ALLOWED_NEW_MIGRATION_STATUSES);

/** A strictly-parsed porcelain line for a file directly under supabase/migrations/. */
export interface MigrationGitStatusEntry {
  /** Exactly two characters, untrimmed (e.g. '??', 'A ', ' M', 'MM'). */
  readonly status: string;
  /** Repo-relative path, e.g. 'supabase/migrations/060_x.sql'. */
  readonly path: string;
  /** Basename, e.g. '060_x.sql'. */
  readonly fileName: string;
}

/**
 * Strictly parse one raw porcelain line into a migration entry.
 *
 * Returns null when the line is not a parseable migration entry — including
 * anything ambiguous (rename/copy arrows, quoted paths, subdirectories, short
 * or malformed lines). A null result means "not a plain migration entry"; the
 * caller decides what that implies. Never throws.
 */
export function parseMigrationGitStatusEntry(line: string): MigrationGitStatusEntry | null {
  if (typeof line !== 'string') return null;
  // 'XY path' — 2 status columns, one separator space, then a non-empty path.
  if (line.length < 4) return null;
  if (line[2] !== ' ') return null;

  const status = line.slice(0, 2);
  const path = line.slice(3);
  if (path.length === 0) return null;

  // Rename/copy entries are 'old -> new'; quoted paths carry escapes. Both are
  // ambiguous to compare by exact string, so they are never parsed as plain.
  if (path.includes(' -> ')) return null;
  if (path.startsWith('"')) return null;
  if (path !== path.trim()) return null;

  if (!path.startsWith(MIGRATIONS_PATH_PREFIX)) return null;

  const fileName = path.slice(MIGRATIONS_PATH_PREFIX.length);
  // Must be a file directly in supabase/migrations/ — not __tests__/… etc.
  if (fileName.length === 0 || fileName.includes('/')) return null;

  return { status, path, fileName };
}

/**
 * True only for a raw porcelain line that is an exactly-reviewed migration in a
 * legitimately new state (`??` or `A `).
 *
 * @param registry optional exact-filename registry (defaults to the canonical
 *   one). Supplied only by tests simulating a future registry — it never
 *   changes the real registry.
 */
export function isAllowedReviewedMigrationGitStatusEntry(
  line: string,
  registry?: readonly string[],
): boolean {
  const entry = parseMigrationGitStatusEntry(line);
  if (entry === null) return false;
  if (!ALLOWED_STATUS_SET.has(entry.status)) return false;

  return registry === undefined
    ? isReviewedMigrationFile(entry.fileName)
    : new Set(registry).has(entry.fileName);
}

/**
 * Every git-status line that is NOT an allowed in-flight reviewed migration.
 *
 * This is the assertion surface for historical guards:
 *   expect(findUnexpectedMigrationGitStatusEntries(rawLines)).toEqual([]);
 *
 * Accepts raw porcelain output (a single string) or an array of raw lines.
 * Blank lines are ignored (porcelain ends with a trailing newline); every other
 * line must earn its place. Returned entries are the original lines, so a
 * failure message shows exactly what git reported.
 */
export function findUnexpectedMigrationGitStatusEntries(
  linesOrOutput: readonly string[] | string,
  registry?: readonly string[],
): string[] {
  const lines = typeof linesOrOutput === 'string' ? linesOrOutput.split('\n') : [...linesOrOutput];
  return lines
    .filter(l => l.length > 0 && l.trim().length > 0)
    .filter(l => !isAllowedReviewedMigrationGitStatusEntry(l, registry));
}

/**
 * The exact porcelain lines that WOULD be allowed for every reviewed migration
 * at the given status. Used by tests to demonstrate the allowed set explicitly;
 * never used to approve anything (approval always flows through the checks
 * above).
 */
export function buildReviewedMigrationGitStatusEntries(
  statusCode: string = '??',
  registry: readonly string[] = REVIEWED_MIGRATION_FILES,
): string[] {
  if (!ALLOWED_STATUS_SET.has(statusCode)) {
    throw new Error(
      `buildReviewedMigrationGitStatusEntries: '${statusCode}' is not an allowed new-migration status`,
    );
  }
  return registry.map(f => `${statusCode} ${MIGRATIONS_PATH_PREFIX}${f}`);
}
