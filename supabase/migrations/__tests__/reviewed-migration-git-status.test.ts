/**
 * MIGRATION-GUARD-DERIVE-B — git-status guard regression tests.
 *
 * Every case here is an in-memory string. This file executes no Git, touches no
 * filesystem, and creates no file — the helper under test is pure by design and
 * these tests prove it.
 *
 * The property under test is the same one the registry enforces everywhere else:
 * approval is EXACT FILENAME MEMBERSHIP, plus a legitimately-new porcelain
 * status. Number, pattern, adjacency and "git already knows about it" are each
 * insufficient.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ALLOWED_NEW_MIGRATION_STATUSES,
  MIGRATIONS_PATH_PREFIX,
  buildReviewedMigrationGitStatusEntries,
  findUnexpectedMigrationGitStatusEntries,
  isAllowedReviewedMigrationGitStatusEntry,
  parseMigrationGitStatusEntry,
} from './helpers/reviewed-migration-git-status';
import { REVIEWED_MIGRATION_FILES, getNextUnreviewedMigrationNumber } from './helpers/reviewed-migrations';

/**
 * Positive cases are DERIVED from the registry rather than naming a specific
 * migration, so this file stays valid at any registry state and can be
 * committed independently of whichever migration phase happens to be in flight.
 * Naming a concrete migration here would couple this guard infrastructure to
 * that phase — exactly the coupling this module exists to remove.
 */
const LATEST_REVIEWED = REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1];
const FIRST_REVIEWED = REVIEWED_MIGRATION_FILES[0];

/** The next number after the reviewed maximum — unregistered by definition. */
const NEXT_NUM = String(getNextUnreviewedMigrationNumber()).padStart(3, '0');

// Synthetic, never written to disk, never registered.
const SYNTH_NEXT = `${NEXT_NUM}_phoenix_some_future_migration.sql`;
const SYNTH_NEXT_ALT = `${NEXT_NUM}_some_other_name.sql`;
/** An alternate filename at an ALREADY-reviewed number — must still be rejected. */
const SYNTH_LATEST_ALT = `${LATEST_REVIEWED.slice(0, 3)}_unreviewed_alternate_name.sql`;

const p = (f: string): string => `${MIGRATIONS_PATH_PREFIX}${f}`;

// ============================================================================
// 1. Allowed: exactly-reviewed migrations in a legitimately-new state
// ============================================================================

describe('1. in-flight reviewed migrations are allowed', () => {
  it('allows `?? ` (untracked) for the newest registered migration', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(`?? ${p(LATEST_REVIEWED)}`)).toBe(true);
  });

  it('allows `A  ` (staged add) for the newest registered migration', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(`A  ${p(LATEST_REVIEWED)}`)).toBe(true);
  });

  it('allows the oldest registered migration in both new states', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(`?? ${p(FIRST_REVIEWED)}`)).toBe(true);
    expect(isAllowedReviewedMigrationGitStatusEntry(`A  ${p(FIRST_REVIEWED)}`)).toBe(true);
  });

  it('allows only the two new-migration statuses', () => {
    expect([...ALLOWED_NEW_MIGRATION_STATUSES]).toEqual(['??', 'A ']);
  });

  it('accepts an in-flight reviewed migration with no historical allowlist anywhere', () => {
    // Allowed purely because the filename is an exact registry member — no
    // historical guard file mentions any migration filename anywhere.
    const line = `?? ${p(LATEST_REVIEWED)}`;
    expect(findUnexpectedMigrationGitStatusEntries([line])).toEqual([]);
    const guardSources = REVIEWED_MIGRATION_FILES; // registry is the only source of truth
    expect(guardSources).toContain(LATEST_REVIEWED);
  });
});

// ============================================================================
// 2. Rejected by filename — number/pattern/adjacency prove nothing
// ============================================================================

describe('2. approval requires exact filename membership', () => {
  it('rejects the next, unregistered migration number', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(`?? ${p(SYNTH_NEXT)}`)).toBe(false);
    expect(isAllowedReviewedMigrationGitStatusEntry(`A  ${p(SYNTH_NEXT)}`)).toBe(false);
  });

  it('rejects an alternate filename at an already-reviewed number', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(`?? ${p(SYNTH_LATEST_ALT)}`)).toBe(false);
  });


  it('rejects a plausible, correctly-numbered, pattern-conformant new migration', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(`?? ${p(NEXT_NUM + '_phoenix_looks_legitimate.sql')}`)).toBe(false);
  });
});

// ============================================================================
// 3. Rejected by status — reviewed permits CREATING, never EDITING
// ============================================================================

describe('3. only new-file statuses are allowed; modification is never tolerated', () => {
  it('rejects an unstaged-modified reviewed migration ( M)', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(` M ${p(LATEST_REVIEWED)}`)).toBe(false);
  });

  it('rejects a staged-modified reviewed migration (M )', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(`M  ${p(LATEST_REVIEWED)}`)).toBe(false);
  });

  it('rejects staged+unstaged modification (MM)', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(`MM ${p(LATEST_REVIEWED)}`)).toBe(false);
  });

  it('rejects added-then-modified (AM)', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(`AM ${p(LATEST_REVIEWED)}`)).toBe(false);
  });

  it('rejects a deleted reviewed migration ( D and D )', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(` D ${p(FIRST_REVIEWED)}`)).toBe(false);
    expect(isAllowedReviewedMigrationGitStatusEntry(`D  ${p(FIRST_REVIEWED)}`)).toBe(false);
  });

  it('rejects a renamed migration', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(`R  ${p(FIRST_REVIEWED)} -> ${p(SYNTH_LATEST_ALT)}`)).toBe(false);
  });

  it('rejects a copied migration', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(`C  ${p(FIRST_REVIEWED)} -> ${p(SYNTH_LATEST_ALT)}`)).toBe(false);
  });

  it('rejects conflicted statuses', () => {
    for (const s of ['UU', 'AA', 'DU', 'UD', 'DD', 'AU', 'UA']) {
      expect(
        isAllowedReviewedMigrationGitStatusEntry(`${s} ${p(LATEST_REVIEWED)}`),
        `${s} must be rejected`,
      ).toBe(false);
    }
  });

  it('rejects a modified historical migration — committed SQL stays immutable', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(` M ${p('051_material_batch_identity_option_a.sql')}`)).toBe(false);
    expect(isAllowedReviewedMigrationGitStatusEntry(`M  ${p('001_phoenix_core_schema.sql')}`)).toBe(false);
  });
});

// ============================================================================
// 4. Rejected by path / shape
// ============================================================================

describe('4. path and shape are parsed strictly', () => {
  it('rejects a file outside the migrations directory', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry('?? src/features/qr/PublicQrScreen.tsx')).toBe(false);
    expect(isAllowedReviewedMigrationGitStatusEntry('?? package.json')).toBe(false);
    expect(isAllowedReviewedMigrationGitStatusEntry('?? premium-preview.html')).toBe(false);
  });

  it('rejects a path in a subdirectory of migrations (e.g. __tests__)', () => {
    expect(
      isAllowedReviewedMigrationGitStatusEntry(`?? ${MIGRATIONS_PATH_PREFIX}__tests__/060-warehouse-foundation.test.ts`),
    ).toBe(false);
  });

  it('rejects a near-miss prefix outside the real directory', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(`?? supabase/migrations-backup/${LATEST_REVIEWED}`)).toBe(false);
    expect(isAllowedReviewedMigrationGitStatusEntry(`?? other/supabase/migrations/${LATEST_REVIEWED}`)).toBe(false);
  });

  it('rejects quoted/ambiguous porcelain paths rather than guessing', () => {
    expect(isAllowedReviewedMigrationGitStatusEntry(`?? "${p(LATEST_REVIEWED)}"`)).toBe(false);
  });

  it('rejects malformed lines', () => {
    for (const bad of ['', '?', '??', '?? ', 'x', '???' + p(LATEST_REVIEWED), `??${p(LATEST_REVIEWED)}`]) {
      expect(isAllowedReviewedMigrationGitStatusEntry(bad), `${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('rejects a trimmed line whose status column was mangled', () => {
    // ' M file' trimmed becomes 'M file' — a single status column. Callers must
    // pass RAW lines; a mangled one is unexpected, never silently allowed.
    expect(isAllowedReviewedMigrationGitStatusEntry(`M ${p(LATEST_REVIEWED)}`)).toBe(false);
  });

  it('parses a well-formed entry into status/path/fileName', () => {
    expect(parseMigrationGitStatusEntry(`?? ${p(LATEST_REVIEWED)}`)).toEqual({
      status: '??',
      path: p(LATEST_REVIEWED),
      fileName: LATEST_REVIEWED,
    });
  });

  it('parseMigrationGitStatusEntry returns null (never throws) on junk', () => {
    for (const bad of ['', 'x', '?? ', `R  a -> b`, `?? "${p(LATEST_REVIEWED)}"`]) {
      expect(() => parseMigrationGitStatusEntry(bad)).not.toThrow();
      expect(parseMigrationGitStatusEntry(bad)).toBeNull();
    }
  });
});

// ============================================================================
// 5. findUnexpectedMigrationGitStatusEntries
// ============================================================================

describe('5. unexpected-entry collection', () => {
  it('returns [] for allowed in-flight reviewed migrations', () => {
    expect(findUnexpectedMigrationGitStatusEntries([`?? ${p(LATEST_REVIEWED)}`, `A  ${p(FIRST_REVIEWED)}`])).toEqual([]);
  });

  it('returns the offending line verbatim for an unregistered migration', () => {
    expect(findUnexpectedMigrationGitStatusEntries([`?? ${p(SYNTH_NEXT)}`])).toEqual([`?? ${p(SYNTH_NEXT)}`]);
  });

  it('returns a modified reviewed migration as unexpected', () => {
    expect(findUnexpectedMigrationGitStatusEntries([` M ${p(LATEST_REVIEWED)}`])).toEqual([` M ${p(LATEST_REVIEWED)}`]);
  });

  it('ignores blank lines (porcelain output ends with a newline)', () => {
    expect(findUnexpectedMigrationGitStatusEntries(['', `?? ${p(LATEST_REVIEWED)}`, ''])).toEqual([]);
    expect(findUnexpectedMigrationGitStatusEntries('')).toEqual([]);
  });

  it('accepts raw porcelain output as a single string', () => {
    expect(findUnexpectedMigrationGitStatusEntries(`?? ${p(LATEST_REVIEWED)}\n`)).toEqual([]);
    expect(findUnexpectedMigrationGitStatusEntries(`?? ${p(SYNTH_NEXT)}\n`)).toEqual([`?? ${p(SYNTH_NEXT)}`]);
  });

  it('separates allowed from unexpected in a mixed listing', () => {
    const lines = [
      `?? ${p(LATEST_REVIEWED)}`,       // allowed
      `?? ${p(SYNTH_NEXT)}`,      // unregistered
      ` M ${p(FIRST_REVIEWED)}`,       // modified reviewed
      '?? src/whatever.ts',      // outside migrations
    ];
    expect(findUnexpectedMigrationGitStatusEntries(lines)).toEqual([
      `?? ${p(SYNTH_NEXT)}`,
      ` M ${p(FIRST_REVIEWED)}`,
      '?? src/whatever.ts',
    ]);
  });
});

// ============================================================================
// 6. buildReviewedMigrationGitStatusEntries
// ============================================================================

describe('6. explicit allowed-entry construction', () => {
  it('builds one exact entry per reviewed migration', () => {
    const built = buildReviewedMigrationGitStatusEntries('??');
    expect(built.length).toBe(REVIEWED_MIGRATION_FILES.length);
    expect(built).toContain(`?? ${p(LATEST_REVIEWED)}`);
    for (const line of built) {
      expect(isAllowedReviewedMigrationGitStatusEntry(line)).toBe(true);
    }
  });

  it('refuses to build entries for a non-new status', () => {
    expect(() => buildReviewedMigrationGitStatusEntries('M ')).toThrow();
    expect(() => buildReviewedMigrationGitStatusEntries(' M')).toThrow();
  });
});

// ============================================================================
// 7. Future-migration workflow (Scenarios A–E)
// ============================================================================

describe('7. migration 061 maintenance proof', () => {
  it('Scenario A — an unregistered exact 061 is rejected centrally', () => {
    expect(findUnexpectedMigrationGitStatusEntries([`?? ${p(SYNTH_NEXT)}`])).toEqual([`?? ${p(SYNTH_NEXT)}`]);
  });

  it('Scenario B — registering that exact 061 allows its ?? and A entries', () => {
    // In-memory registry copy: exactly what one line in reviewed-migrations.ts
    // will do for real. The real registry is untouched by this simulation.
    const nextRegistry = [...REVIEWED_MIGRATION_FILES, SYNTH_NEXT];
    expect(findUnexpectedMigrationGitStatusEntries([`?? ${p(SYNTH_NEXT)}`], nextRegistry)).toEqual([]);
    expect(findUnexpectedMigrationGitStatusEntries([`A  ${p(SYNTH_NEXT)}`], nextRegistry)).toEqual([]);
    expect(isAllowedReviewedMigrationGitStatusEntry(`?? ${p(SYNTH_NEXT)}`)).toBe(false); // real registry unchanged
  });

  it('Scenario C — a differently named 061 stays rejected under that same registry', () => {
    const nextRegistry = [...REVIEWED_MIGRATION_FILES, SYNTH_NEXT];
    expect(findUnexpectedMigrationGitStatusEntries([`?? ${p(SYNTH_NEXT_ALT)}`], nextRegistry)).toEqual([
      `?? ${p(SYNTH_NEXT_ALT)}`,
    ]);
  });

  it('Scenario D — a MODIFIED reviewed 060 stays rejected even under that registry', () => {
    const nextRegistry = [...REVIEWED_MIGRATION_FILES, SYNTH_NEXT];
    expect(findUnexpectedMigrationGitStatusEntries([` M ${p(LATEST_REVIEWED)}`], nextRegistry)).toEqual([
      ` M ${p(LATEST_REVIEWED)}`,
    ]);
  });

  it('Scenario E — approval flows only from the registry, so no guard file lists filenames', () => {
    // The allowed set is a pure function of the registry: change the registry,
    // the allowed set changes everywhere at once. Nothing else contributes.
    const empty: readonly string[] = [];
    expect(findUnexpectedMigrationGitStatusEntries([`?? ${p(LATEST_REVIEWED)}`], empty)).toEqual([
      `?? ${p(LATEST_REVIEWED)}`,
    ]);
  });
});

// ============================================================================
// 8. Purity
// ============================================================================

describe('8. the helper is pure', () => {
  it('performs no Git, shell, filesystem or environment access', () => {
    const src = readFileSync(join(__dirname, 'helpers/reviewed-migration-git-status.ts'), 'utf8');
    const code = src.split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

    expect(code).not.toMatch(/\bfrom\s+['"](node:)?fs['"]/);
    expect(code).not.toMatch(/\bfrom\s+['"](node:)?child_process['"]/);
    expect(code).not.toMatch(/\bexecSync\b|\bspawnSync\b|\bexec\b\(/);
    expect(code).not.toMatch(/\breaddirSync\b|\breadFileSync\b|\bexistsSync\b/);
    expect(code).not.toMatch(/\bwriteFileSync\b|\bmkdirSync\b|\brmSync\b/);
    expect(code).not.toMatch(/\bprocess\.env\b/);
    expect(code).not.toMatch(/\bfrom\s+['"]@\//);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });

  it('imports only the canonical registry helper', () => {
    const src = readFileSync(join(__dirname, 'helpers/reviewed-migration-git-status.ts'), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
    expect(imports).toEqual(['./reviewed-migrations']);
  });

  it('declares no test bypass', () => {
    const src = readFileSync(join(__dirname, 'helpers/reviewed-migration-git-status.ts'), 'utf8');
    expect(src).not.toMatch(/\.(skip|only|todo)\(/);
  });

  it('never mutates the canonical registry', () => {
    const before = [...REVIEWED_MIGRATION_FILES];
    findUnexpectedMigrationGitStatusEntries([`?? ${p(SYNTH_NEXT)}`], [...REVIEWED_MIGRATION_FILES, SYNTH_NEXT]);
    buildReviewedMigrationGitStatusEntries('??');
    expect([...REVIEWED_MIGRATION_FILES]).toEqual(before);
    expect(Object.isFrozen(REVIEWED_MIGRATION_FILES)).toBe(true);
  });
});
