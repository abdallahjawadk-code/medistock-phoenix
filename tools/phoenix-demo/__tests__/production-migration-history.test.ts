/**
 * PRODUCTION MIGRATION HISTORY RECONCILIATION — refusal matrix.
 *
 * The executor's original single-pending guarantee rested on Production's
 * `schema_migrations.version` being the canonical ordinal, contiguous 1..N.
 * That is false: Production carries 172 three-digit versions followed by
 * 14-digit Supabase CLI timestamps, and casting them to int4 fails outright.
 *
 * These tests pin the replacement: a total, one-to-one reconciliation between
 * the two namespaces, where every ambiguity refuses rather than resolves.
 * Pure — no database, no CLI, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  MigrationHistoryRefusal,
  assertRemoteHistoryVersionUsable,
  canonicalStem,
  isValidTimestampVersion,
  reconcileMigrationHistory,
} from '../production-migration-history.mjs';

/** Local canonical manifest 1..197, matching this repository's shape. */
const LOCAL = Array.from({ length: 197 }, (_, i) => ({
  version: i + 1,
  filename: `${String(i + 1).padStart(3, '0')}_phoenix_step_${i + 1}.sql`,
}));

/** Two hours apart, ascending — the shape the CLI actually writes. */
const stamp = (k: number) =>
  new Date(Date.UTC(2026, 7, 10, 20, 8, 46) + k * 7_200_000)
    .toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

/** Production's real shape: 172 numeric + 24 timestamp = 196 rows. */
function productionShapedRows(numericCount = 172, stampedCount = 24) {
  const rows: { version: string; name: string }[] = [];
  for (let i = 1; i <= numericCount; i++) {
    rows.push({ version: String(i).padStart(3, '0'), name: `legacy_name_${i}` });
  }
  for (let k = 0; k < stampedCount; k++) {
    const canonical = numericCount + k + 1;
    const local = LOCAL[canonical - 1];
    rows.push({ version: stamp(k), name: local ? canonicalStem(local.filename) : `${canonical}_phoenix_step_${canonical}` });
  }
  return rows;
}

function expectRefusal(fn: () => unknown, code: string) {
  let thrown: unknown;
  try { fn(); } catch (e) { thrown = e; }
  expect(thrown, `expected refusal ${code}, got none`).toBeInstanceOf(MigrationHistoryRefusal);
  expect((thrown as MigrationHistoryRefusal).code).toBe(code);
  return thrown as MigrationHistoryRefusal;
}

describe('reconciliation — the real Production shape', () => {
  it('reconciles 172 numeric + 24 timestamp rows to canonical ceiling 196', () => {
    const r = reconcileMigrationHistory(productionShapedRows(), LOCAL);
    expect(r.numericRowCount).toBe(172);
    expect(r.timestampRowCount).toBe(24);
    expect(r.canonicalCeiling).toBe(196);
    expect(r.mapping).toHaveLength(196);
    expect(r.appliedCanonical).toHaveLength(196);
    expect(r.pendingCanonical).toEqual([197]);
  });

  it('places the era transition immediately after canonical 172', () => {
    const rows = productionShapedRows();
    const r = reconcileMigrationHistory(rows, LOCAL);
    const last = r.mapping.find((m) => m.canonical === 172)!;
    const first = r.mapping.find((m) => m.canonical === 173)!;
    expect(last.era).toBe('numeric');
    expect(last.remoteVersion).toBe('172');
    expect(first.era).toBe('timestamp');
    expect(first.remoteVersion).toBe(r.transitionVersion);
    expect(first.remoteVersion).toMatch(/^\d{14}$/);
  });

  it('never casts a version to a number — a 14-digit stamp survives intact', () => {
    const r = reconcileMigrationHistory(productionShapedRows(), LOCAL);
    for (const m of r.mapping.filter((x) => x.era === 'timestamp')) {
      expect(typeof m.remoteVersion).toBe('string');
      expect(m.remoteVersion).toHaveLength(14);
      // The value that broke the previous executor must round-trip exactly.
      expect(Number.isSafeInteger(Number(m.remoteVersion))).toBe(true);
      expect(String(m.remoteVersion)).toBe(m.remoteVersion);
    }
  });

  it('reports ALREADY_APPLIED shape once the target is present', () => {
    const rows = productionShapedRows(172, 25); // 197 rows total
    const r = reconcileMigrationHistory(rows, LOCAL);
    expect(r.canonicalCeiling).toBe(197);
    expect(r.pendingCanonical).toEqual([]);
  });
});

describe('reconciliation — every ambiguity refuses', () => {
  it('duplicate remote version', () => {
    const rows = productionShapedRows();
    rows.push({ version: '050', name: 'legacy_name_50' });
    expectRefusal(() => reconcileMigrationHistory(rows, LOCAL), 'REMOTE_DUPLICATE_VERSION');
  });

  it('gap in the numeric era', () => {
    const rows = productionShapedRows().filter((r) => r.version !== '100');
    expectRefusal(() => reconcileMigrationHistory(rows, LOCAL), 'REMOTE_NUMERIC_GAP');
  });

  it('malformed version shape (not 3 and not 14 digits)', () => {
    const rows = productionShapedRows();
    rows.push({ version: '1234', name: 'x' });
    expectRefusal(() => reconcileMigrationHistory(rows, LOCAL), 'REMOTE_VERSION_SHAPE');
  });

  it('14 digits that are not a real instant', () => {
    const rows = productionShapedRows();
    rows.push({ version: '20261332000000', name: 'x' });
    expectRefusal(() => reconcileMigrationHistory(rows, LOCAL), 'REMOTE_TIMESTAMP_INVALID');
  });

  it('duplicate timestamp', () => {
    const rows = productionShapedRows();
    rows.push({ version: stamp(3), name: 'dupe' });
    expectRefusal(() => reconcileMigrationHistory(rows, LOCAL), 'REMOTE_DUPLICATE_VERSION');
  });

  it('timestamp/name mismatch — ordering alone must never decide identity', () => {
    const rows = productionShapedRows();
    const target = rows.find((r) => /^\d{14}$/.test(r.version))!;
    target.name = '999_phoenix_not_this_one';
    expectRefusal(() => reconcileMigrationHistory(rows, LOCAL), 'REMOTE_NAME_MISMATCH');
  });

  it('timestamp row with no name at all', () => {
    const rows = productionShapedRows();
    const target = rows.find((r) => /^\d{14}$/.test(r.version))!;
    (target as { name: string | null }).name = null;
    expectRefusal(() => reconcileMigrationHistory(rows, LOCAL), 'REMOTE_NAME_MISSING');
  });

  // Rows mapping past the local ceiling are caught by the earlier
  // per-row existence check, which names the exact canonical number rather
  // than only reporting an aggregate. REMOTE_AHEAD_OF_LOCAL therefore stands
  // as a defensive backstop; it is asserted as present, not claimed covered.
  it('Production ahead of this checkout', () => {
    const rows = productionShapedRows(172, 30); // canonical 202 > local 197
    expectRefusal(() => reconcileMigrationHistory(rows, LOCAL), 'CANONICAL_MIGRATION_MISSING_LOCALLY');
  });

  it('a mapped canonical migration missing from the checkout', () => {
    const short = LOCAL.slice(0, 180);
    expectRefusal(() => reconcileMigrationHistory(productionShapedRows(), short), 'CANONICAL_MIGRATION_MISSING_LOCALLY');
  });

  it('empty histories', () => {
    expectRefusal(() => reconcileMigrationHistory([], LOCAL), 'REMOTE_HISTORY_EMPTY');
    expectRefusal(() => reconcileMigrationHistory(productionShapedRows(), []), 'LOCAL_MANIFEST_EMPTY');
  });

  it('no numeric era at all', () => {
    const rows = productionShapedRows(0, 24);
    expectRefusal(() => reconcileMigrationHistory(rows, LOCAL), 'REMOTE_NUMERIC_ERA_MISSING');
  });
});

describe('the target remote-history version is frozen, validated, never invented', () => {
  const rows = productionShapedRows();

  it('accepts a valid instant strictly newer than everything applied', () => {
    expect(assertRemoteHistoryVersionUsable('20260823181015', rows)).toBe('20260823181015');
  });

  it('refuses a version already present', () => {
    expectRefusal(() => assertRemoteHistoryVersionUsable(stamp(0), rows), 'TARGET_VERSION_ALREADY_PRESENT');
  });

  it('refuses a version not strictly newer than the newest applied stamp', () => {
    expectRefusal(() => assertRemoteHistoryVersionUsable('20260101000000', rows), 'TARGET_VERSION_NOT_NEWEST');
  });

  it('refuses a malformed or impossible stamp', () => {
    expectRefusal(() => assertRemoteHistoryVersionUsable('2026082318101', rows), 'TARGET_VERSION_SHAPE');
    expectRefusal(() => assertRemoteHistoryVersionUsable('20261332000000', rows), 'TARGET_VERSION_INVALID');
  });
});

describe('timestamp validity helper', () => {
  it('accepts real instants and rejects impossible ones', () => {
    expect(isValidTimestampVersion('20260810200846')).toBe(true);
    expect(isValidTimestampVersion('20260823131150')).toBe(true);
    expect(isValidTimestampVersion('20260230000000')).toBe(false); // 30 Feb
    expect(isValidTimestampVersion('20261301000000')).toBe(false); // month 13
    expect(isValidTimestampVersion('20260810206046')).toBe(false); // minute 60
    expect(isValidTimestampVersion('123')).toBe(false);
  });
});
