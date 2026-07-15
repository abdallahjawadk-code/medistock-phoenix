/**
 * MIGRATION-GUARD-DERIVE-A — filesystem side of the migration guards (test-only).
 *
 * Kept separate from `reviewed-migrations.ts` on purpose: the registry module
 * must stay pure and must never learn what is on disk, because a registry that
 * can read the directory would make every file self-approving. This module is
 * the only place the migrations directory is enumerated for inventory guards,
 * and it never decides what is approved — it only reports what exists.
 *
 * Read-only: no file is created, modified or removed here.
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import { extractMigrationNumber, sortMigrationFiles } from './reviewed-migrations';

/** Absolute path to supabase/migrations (this file lives in __tests__/helpers). */
export const MIGRATIONS_DIR_PATH = join(__dirname, '../../');

/** Every `.sql` file currently in the migrations directory, canonical order. */
export function actualMigrationFiles(dir: string = MIGRATIONS_DIR_PATH): string[] {
  return sortMigrationFiles(readdirSync(dir).filter(f => f.endsWith('.sql')));
}

/**
 * Numbered `.sql` files on disk with number strictly above `afterNumber`.
 *
 * Replaces the old per-file `/^0(4[4-9]|[5-9][0-9])_/` range scans. Note this is
 * broader than those regexes were: it has no upper bound, so a 100+ migration
 * would still be caught rather than silently skipped.
 */
export function actualMigrationFilesAbove(
  afterNumber: number,
  dir: string = MIGRATIONS_DIR_PATH,
): string[] {
  return sortMigrationFiles(
    readdirSync(dir).filter(f => {
      const n = extractMigrationNumber(f);
      return n !== null && n > afterNumber;
    }),
  );
}

/** Numbered `.sql` files on disk whose number is within [from, to] inclusive. */
export function actualMigrationFilesBetween(
  from: number,
  to: number,
  dir: string = MIGRATIONS_DIR_PATH,
): string[] {
  return sortMigrationFiles(
    readdirSync(dir).filter(f => {
      const n = extractMigrationNumber(f);
      return n !== null && n >= from && n <= to;
    }),
  );
}
