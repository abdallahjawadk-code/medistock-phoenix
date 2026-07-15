/**
 * MIGRATION-GUARD-DERIVE-A — canonical migration-review manifest test.
 *
 * This is the single place where "which migrations have been reviewed?" is
 * enforced against the real supabase/migrations directory. Historical test files
 * derive their inventory assertions from the same registry instead of carrying
 * their own copies.
 *
 * The property under test is EXACT FILENAME MEMBERSHIP. Every synthetic case
 * below exists to prove that presence, numbering, contiguity, and pattern-match
 * are each insufficient on their own.
 *
 * Synthetic cases operate on in-memory filename arrays only — no file is ever
 * written to the real migrations directory.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  REVIEWED_MIGRATION_FILES,
  extractMigrationNumber,
  findDuplicateReviewedFilenames,
  findDuplicateReviewedNumbers,
  findMalformedMigrationFiles,
  findMalformedReviewedFilenames,
  findMissingReviewedMigrationFiles,
  findUnreviewedMigrationFiles,
  getMaximumReviewedMigrationNumber,
  getNextUnreviewedMigrationNumber,
  isNumberedMigrationFile,
  isReviewedMigrationFile,
  reviewedMigrationFilesAbove,
  reviewedMigrationFilesBetween,
  sortMigrationFiles,
} from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

/** Real `.sql` files on disk (excludes __tests__/ and any non-SQL entry). */
const actualSqlFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));

// Synthetic filenames — never written to disk.
//
// USER-RBAC-U1-SCOPE-062-IMPLEMENT-A: migration 062 is now genuinely reviewed
// and registered, so the "next unreviewed number" synthetic moved 062 → 063.
// This is the intended maintenance step the registry was designed for, and it
// happened HERE ONLY — no historical guard file needed an edit.
const SYNTH_NEXT = '063_unreviewed_test_migration.sql';
const SYNTH_NEXT_ALT = '063_phoenix_some_other_name.sql';
const SYNTH_060_ALT = '060_phoenix_some_other_name.sql';
const SYNTH_059_ALT = '059_unreviewed_alternate_name.sql';
const SYNTH_HIGH = '999_phoenix_very_high_number.sql';
const SYNTH_MALFORMED = 'hotfix_no_number.sql';
const REAL_059 = '059_phoenix_public_qr_concentration.sql';
const REAL_060 = '060_phoenix_warehouse_foundation.sql';
const REAL_061 = '061_phoenix_warehouse_dispatch_schema.sql';
const REAL_062 = '062_phoenix_user_rbac_scope_foundation.sql';

// ============================================================================
// 1. Registry shape — exact filenames, no duplicates, deterministic order
// ============================================================================

describe('1. registry contains exact filenames only', () => {
  it('every entry is a concrete NNN_name.sql filename (no globs, ranges or regex)', () => {
    for (const f of REVIEWED_MIGRATION_FILES) {
      expect(isNumberedMigrationFile(f), `${f} must be a well-formed filename`).toBe(true);
      expect(f).not.toMatch(/[*?[\]{}()|^$\\]/); // no wildcard/regex metacharacters
    }
  });

  it('contains no malformed entries', () => {
    expect(findMalformedReviewedFilenames()).toEqual([]);
  });

  it('contains no duplicate exact filename', () => {
    expect(findDuplicateReviewedFilenames()).toEqual([]);
  });

  it('contains no duplicate migration number (repo has no reviewed duplicates)', () => {
    expect(findDuplicateReviewedNumbers()).toEqual([]);
  });

  it('is stored in deterministic canonical order', () => {
    expect([...REVIEWED_MIGRATION_FILES]).toEqual(sortMigrationFiles(REVIEWED_MIGRATION_FILES));
  });

  it('sorting is stable and deterministic regardless of input order', () => {
    const shuffled = [...REVIEWED_MIGRATION_FILES].reverse();
    expect(sortMigrationFiles(shuffled)).toEqual(sortMigrationFiles(REVIEWED_MIGRATION_FILES));
  });
});

// ============================================================================
// 2. Registry ↔ disk agreement (both directions)
// ============================================================================

describe('2. registry and disk agree exactly, in both directions', () => {
  it('every registry entry exists on disk (no missing reviewed migration)', () => {
    expect(findMissingReviewedMigrationFiles(actualSqlFiles())).toEqual([]);
  });

  it('every SQL file on disk is in the registry (no unreviewed migration accepted)', () => {
    expect(findUnreviewedMigrationFiles(actualSqlFiles())).toEqual([]);
  });

  it('no malformed SQL file is present on disk', () => {
    expect(findMalformedMigrationFiles(actualSqlFiles())).toEqual([]);
  });

  it('disk and registry are the same set, exactly', () => {
    expect(sortMigrationFiles(actualSqlFiles())).toEqual([...REVIEWED_MIGRATION_FILES]);
  });
});

// ============================================================================
// 3. Maximum is derived from the registry, not from the directory
// ============================================================================

describe('3. reviewed maximum derives from the registry', () => {
  it('the current reviewed maximum is 62', () => {
    expect(getMaximumReviewedMigrationNumber()).toBe(62);
  });

  it('the next unreviewed number is 63', () => {
    expect(getNextUnreviewedMigrationNumber()).toBe(63);
  });

  it('the maximum equals the highest number in the registry itself', () => {
    const highest = Math.max(
      ...REVIEWED_MIGRATION_FILES.map(extractMigrationNumber).filter((n): n is number => n !== null),
    );
    expect(getMaximumReviewedMigrationNumber()).toBe(highest);
  });

  it('a file on disk cannot raise the ceiling merely by existing', () => {
    // The helper never reads the directory: the ceiling is a property of the
    // registry alone. Pretending 999 is on disk changes nothing.
    const pretendDisk = [...actualSqlFiles(), SYNTH_HIGH];
    expect(getMaximumReviewedMigrationNumber()).toBe(62);
    expect(findUnreviewedMigrationFiles(pretendDisk)).toEqual([SYNTH_HIGH]);
  });
});

// ============================================================================
// 4. Migrations 059–062 registered by exact real name; 063 is not registered
// ============================================================================

describe('4. migrations 059–062 registered by exact name; 063 absent', () => {
  it('contains migration 059 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_059);
    expect(isReviewedMigrationFile(REAL_059)).toBe(true);
  });

  it('contains migration 060 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_060);
    expect(isReviewedMigrationFile(REAL_060)).toBe(true);
  });

  it('registers exactly one migration 060 (no alternate 060 name)', () => {
    const sixties = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 60);
    expect(sixties).toEqual([REAL_060]);
    expect(isReviewedMigrationFile(SYNTH_060_ALT)).toBe(false);
  });

  it('contains migration 061 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_061);
    expect(isReviewedMigrationFile(REAL_061)).toBe(true);
  });

  it('contains migration 062 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_062);
    expect(isReviewedMigrationFile(REAL_062)).toBe(true);
  });

  it('registers exactly one migration 062 (no alternate 062 name)', () => {
    const sixtyTwos = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 62);
    expect(sixtyTwos).toEqual([REAL_062]);
    expect(isReviewedMigrationFile('062_phoenix_some_other_name.sql')).toBe(false);
  });

  it('does not register migration 063 in any form', () => {
    const sixtyThrees = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 63);
    expect(sixtyThrees).toEqual([]);
  });
});

// ============================================================================
// 5. Rejection proofs — presence, number, and pattern are each insufficient
// ============================================================================

describe('5. approval requires exact filename membership, nothing less', () => {
  it('rejects a synthetic unreviewed migration 063 (the next unreviewed number)', () => {
    expect(isReviewedMigrationFile(SYNTH_NEXT)).toBe(false);
    expect(findUnreviewedMigrationFiles([...actualSqlFiles(), SYNTH_NEXT])).toEqual([SYNTH_NEXT]);
  });

  it('rejects a name that matches the naming pattern but is not registered', () => {
    // Well-formed, plausible, correctly numbered — and still rejected.
    expect(isNumberedMigrationFile(SYNTH_060_ALT)).toBe(true);
    expect(isReviewedMigrationFile(SYNTH_060_ALT)).toBe(false);
  });

  it('rejects an alternate filename at an already-reviewed number (059)', () => {
    // 59 <= max reviewed (59), yet the exact name is unknown ⇒ rejected.
    expect(extractMigrationNumber(SYNTH_059_ALT)).toBe(59);
    expect(extractMigrationNumber(SYNTH_059_ALT)!).toBeLessThanOrEqual(
      getMaximumReviewedMigrationNumber(),
    );
    expect(isReviewedMigrationFile(SYNTH_059_ALT)).toBe(false);
    expect(findUnreviewedMigrationFiles([...actualSqlFiles(), SYNTH_059_ALT])).toEqual([
      SYNTH_059_ALT,
    ]);
  });

  it('rejects a very high-number migration', () => {
    expect(isReviewedMigrationFile(SYNTH_HIGH)).toBe(false);
    expect(findUnreviewedMigrationFiles([SYNTH_HIGH])).toEqual([SYNTH_HIGH]);
  });

  it('rejects a non-numbered SQL file rather than ignoring it', () => {
    expect(isReviewedMigrationFile(SYNTH_MALFORMED)).toBe(false);
    expect(findUnreviewedMigrationFiles([...actualSqlFiles(), SYNTH_MALFORMED])).toEqual([
      SYNTH_MALFORMED,
    ]);
    expect(findMalformedMigrationFiles([...actualSqlFiles(), SYNTH_MALFORMED])).toEqual([
      SYNTH_MALFORMED,
    ]);
  });

  it('rejects near-miss variants of a real reviewed filename', () => {
    for (const nearMiss of [
      '059_phoenix_public_qr_concentration.SQL', // different case extension
      '059_phoenix_public_qr_concentrations.sql', // trailing s
      '59_phoenix_public_qr_concentration.sql', // two-digit number
      '059_phoenix_public_qr_concentration.sql.bak', // suffixed
      ' 059_phoenix_public_qr_concentration.sql', // leading space
    ]) {
      expect(isReviewedMigrationFile(nearMiss), `${nearMiss} must not be reviewed`).toBe(false);
    }
  });

  it('uses no wildcard or range acceptance — membership is Set-exact', () => {
    // A registry-derived prefix/range rule would wrongly admit these; Set
    // membership does not.
    expect(isReviewedMigrationFile('059_')).toBe(false);
    expect(isReviewedMigrationFile('059')).toBe(false);
    expect(isReviewedMigrationFile('*.sql')).toBe(false);
    expect(isReviewedMigrationFile('')).toBe(false);
  });
});

// ============================================================================
// 6. Registry-derived slices keep exact-filename semantics
// ============================================================================

describe('6. derived slices remain exact-filename lists', () => {
  it('reviewedMigrationFilesAbove(43) yields the exact 044–062 filenames', () => {
    expect(reviewedMigrationFilesAbove(43)).toEqual([
      '044_phoenix_profiles_whatsapp_phone.sql',
      '045_phoenix_update_my_whatsapp_phone_rpc.sql',
      '046_phoenix_set_my_org_whatsapp_contact_rpc.sql',
      '047_phoenix_live_alerts_contact_fields.sql',
      '048_live_alerts_expiry_risk_tiers.sql',
      '049_add_national_code_to_item_availability.sql',
      '050_phoenix_upsert_availability_national_code.sql',
      '051_material_batch_identity_option_a.sql',
      '052_qr_effective_condition_quantity_zero.sql',
      '053_item_availability_removed_marker.sql',
      '054_dashboard_condition_counts_rpcs.sql',
      '055_phoenix_clean_availability_data.sql',
      '056_phoenix_platform_broadcast_notices.sql',
      '057_phoenix_platform_broadcast_admin_details_delete.sql',
      '058_phoenix_public_qr_dosage_form.sql',
      '059_phoenix_public_qr_concentration.sql',
      '060_phoenix_warehouse_foundation.sql',
      '061_phoenix_warehouse_dispatch_schema.sql',
      '062_phoenix_user_rbac_scope_foundation.sql',
    ]);
  });

  it('reviewedMigrationFilesAbove(62) is empty (nothing beyond the ceiling)', () => {
    expect(reviewedMigrationFilesAbove(62)).toEqual([]);
  });

  it('every derived slice entry is itself an exactly-reviewed filename', () => {
    for (const f of reviewedMigrationFilesAbove(0)) {
      expect(isReviewedMigrationFile(f)).toBe(true);
    }
  });

  it('reviewedMigrationFilesBetween is inclusive and exact', () => {
    expect(reviewedMigrationFilesBetween(58, 62)).toEqual([
      '058_phoenix_public_qr_dosage_form.sql',
      '059_phoenix_public_qr_concentration.sql',
      '060_phoenix_warehouse_foundation.sql',
      '061_phoenix_warehouse_dispatch_schema.sql',
      '062_phoenix_user_rbac_scope_foundation.sql',
    ]);
  });

  it('slices cover the registry with no gaps or invented names', () => {
    expect(reviewedMigrationFilesAbove(0)).toEqual([...REVIEWED_MIGRATION_FILES]);
  });
});

// ============================================================================
// 7. Future-migration workflow (Scenarios A–D)
// ============================================================================

describe('7. future-migration workflow', () => {
  it('Scenario A — unreviewed 063 on disk fails validation', () => {
    const disk = [...actualSqlFiles(), SYNTH_NEXT];
    const unreviewed = findUnreviewedMigrationFiles(disk);
    expect(unreviewed).toEqual([SYNTH_NEXT]);
    // "validation fails" = the manifest assertion this test file makes would fail.
    expect(unreviewed.length).toBeGreaterThan(0);
  });

  it('Scenario B — explicitly reviewing 063 accepts that exact name only', () => {
    // In-memory registry copy: exactly what registering migration 062 did for real.
    const nextRegistry = new Set([...REVIEWED_MIGRATION_FILES, SYNTH_NEXT]);
    const isReviewedNext = (f: string): boolean => nextRegistry.has(f);

    expect(isReviewedNext(SYNTH_NEXT)).toBe(true); // the reviewed name is accepted
    expect(isReviewedNext(SYNTH_060_ALT)).toBe(false); // a different 060 is NOT
    // The real registry is untouched by the simulation.
    expect(isReviewedMigrationFile(SYNTH_NEXT)).toBe(false);
  });

  it('Scenario C — an alternate 059 name stays rejected despite 59 <= max', () => {
    expect(isReviewedMigrationFile(SYNTH_059_ALT)).toBe(false);
    expect(extractMigrationNumber(SYNTH_059_ALT)).toBeLessThanOrEqual(
      getMaximumReviewedMigrationNumber(),
    );
  });

  it('Scenario D — a reviewed file missing from disk is reported', () => {
    const diskWithout059 = actualSqlFiles().filter(f => f !== REAL_059);
    expect(findMissingReviewedMigrationFiles(diskWithout059)).toEqual([REAL_059]);
  });

  it('adding a disk file without registering it fails (registry is the gate)', () => {
    expect(findUnreviewedMigrationFiles([...actualSqlFiles(), SYNTH_NEXT])).not.toEqual([]);
  });

  it('registering a name without shipping the file fails (disk is the counter-gate)', () => {
    const pretendRegistry = [...REVIEWED_MIGRATION_FILES, SYNTH_NEXT];
    const actual = new Set(actualSqlFiles());
    expect(pretendRegistry.filter(f => !actual.has(f))).toEqual([SYNTH_NEXT]);
  });
});

// ============================================================================
// 8. Purity — the registry cannot be self-approving
// ============================================================================

describe('8. registry purity', () => {
  it('is frozen (cannot be mutated at runtime by a test)', () => {
    expect(Object.isFrozen(REVIEWED_MIGRATION_FILES)).toBe(true);
    expect(() => {
      (REVIEWED_MIGRATION_FILES as string[]).push(SYNTH_NEXT);
    }).toThrow();
    expect(isReviewedMigrationFile(SYNTH_NEXT)).toBe(false);
  });

  it('helper source performs no filesystem access and imports no production code', () => {
    // Reading the helper's own source keeps "never derive the registry from
    // disk" enforceable rather than merely documented in a comment.
    const src = readFileSync(join(__dirname, 'helpers/reviewed-migrations.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');

    expect(code).not.toMatch(/\bfrom\s+['"](node:)?fs['"]/); // no fs import
    expect(code).not.toMatch(/\brequire\s*\(/); // no dynamic require
    expect(code).not.toMatch(/\breaddirSync\b|\breadFileSync\b|\bexistsSync\b/);
    expect(code).not.toMatch(/\bprocess\.env\b/); // no env-dependent behavior
    expect(code).not.toMatch(/\bfrom\s+['"]@\//); // no production module import
    expect(code).not.toMatch(/\bwriteFileSync\b|\bmkdirSync\b|\brmSync\b/); // no mutation
  });

  it('helper declares no test bypasses', () => {
    const src = readFileSync(join(__dirname, 'helpers/reviewed-migrations.ts'), 'utf8');
    expect(src).not.toMatch(/\.(skip|only|todo)\(/);
    expect(src).not.toMatch(/\btry\s*\{/); // no swallowed failures
  });
});
