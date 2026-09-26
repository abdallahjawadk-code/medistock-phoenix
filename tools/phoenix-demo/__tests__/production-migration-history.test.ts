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
  HISTORICAL_REMOTE_NAME_EXCEPTIONS,
  MigrationHistoryRefusal,
  assertPostApplyAcceptance,
  assertRemoteHistoryVersionUsable,
  canonicalStem,
  classifyPendingTail,
  expectedRemoteName,
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


// ===========================================================================
// PRODUCTION'S REAL TIMESTAMP-ERA NAMING.
//
// Production's timestamp rows record the FULL canonical stem, except for
// exactly two documented events:
//   - canonical 173 records `phoenix_database_security_surface_hardening` with
//     no `173_` prefix, because its original filename's timestamp replaced the
//     prefix rather than preceding it. Executor run 32667193982 refused on it.
//   - canonical 214 records `fix_central_needs_review_readiness_volatility`
//     under version 20260914111813. Executor run 35925796412 refused on it.
//
// The fix must accept exactly those two rows -- each only on its own exact
// canonical ordinal, canonical filename AND remote version -- and nothing
// else. These tests pin both halves: the exceptions are honoured, and every
// neighbouring or look-alike form still refuses.
// ===========================================================================
const M173_FILENAME = '173_phoenix_database_security_surface_hardening.sql';
const M173_NAME = 'phoenix_database_security_surface_hardening';
const M174_FILENAME = '174_phoenix_authenticated_rpc_surface_hardening.sql';

/** LOCAL, but with 173 and 174 carrying their REAL repository filenames. */
const REAL_LOCAL = LOCAL.map((m) => {
  if (m.version === 173) return { version: 173, filename: M173_FILENAME };
  if (m.version === 174) return { version: 174, filename: M174_FILENAME };
  return m;
});

/** Production's real shape; `overrides` replaces a canonical row's fields. */
function realShapedRows(overrides: Record<number, { version?: string; name?: string }> = {}) {
  const rows: { version: string; name: string }[] = [];
  for (let i = 1; i <= 172; i++) rows.push({ version: String(i).padStart(3, '0'), name: `legacy_name_${i}` });
  for (let k = 0; k < 24; k++) {
    const canonical = 172 + k + 1;
    const local = REAL_LOCAL[canonical - 1];
    rows.push({
      version: stamp(k),
      name: canonical === 173 ? M173_NAME : canonicalStem(local.filename),
      ...(overrides[canonical] ?? {}),
    });
  }
  return rows;
}

describe('historical remote-name exception — canonical 173 (exact triple)', () => {
  it('stamp(0) is the real Production version for canonical 173', () => {
    expect(stamp(0)).toBe('20260810200846');
  });

  it('reconciles the real shape: 173 unprefixed, 174-196 prefixed', () => {
    const r = reconcileMigrationHistory(realShapedRows(), REAL_LOCAL);
    expect(r.canonicalCeiling).toBe(196);
    expect(r.pendingCanonical).toEqual([197]);
    const m173 = r.mapping.find((m) => m.canonical === 173);
    const m174 = r.mapping.find((m) => m.canonical === 174);
    expect(m173?.remoteName).toBe(M173_NAME);
    expect(m173?.remoteVersion).toBe('20260810200846');
    expect(m174?.remoteName).toBe('174_phoenix_authenticated_rpc_surface_hardening');
  });

  it('REFUSES when 174 loses its canonical prefix — the exception is not a rule', () => {
    expectRefusal(
      () => reconcileMigrationHistory(
        realShapedRows({ 174: { name: 'phoenix_authenticated_rpc_surface_hardening' } }), REAL_LOCAL),
      'REMOTE_NAME_MISMATCH',
    );
  });

  it('REFUSES when 173 GAINS the canonical prefix — the exception is exact, not optional', () => {
    expectRefusal(
      () => reconcileMigrationHistory(
        realShapedRows({ 173: { name: '173_phoenix_database_security_surface_hardening' } }), REAL_LOCAL),
      'REMOTE_NAME_MISMATCH',
    );
  });

  it('REFUSES an arbitrary alternative name for 173', () => {
    for (const name of ['phoenix_database_security_surface_hardening_v2', 'database_security_surface_hardening', 'phoenix_step_173', '']) {
      expectRefusal(
        () => reconcileMigrationHistory(realShapedRows({ 173: { name } }), REAL_LOCAL),
        name === '' ? 'REMOTE_NAME_MISSING' : 'REMOTE_NAME_MISMATCH',
      );
    }
  });

  it('does NOT silently accept a second unprefixed row', () => {
    for (const canonical of [175, 180, 196]) {
      const local = REAL_LOCAL[canonical - 1];
      const stripped = canonicalStem(local.filename).replace(/^\d{3}_/, '');
      expectRefusal(
        () => reconcileMigrationHistory(realShapedRows({ [canonical]: { name: stripped } }), REAL_LOCAL),
        'REMOTE_NAME_MISMATCH',
      );
    }
  });

  it('binds the exception to the exact canonical FILENAME, not merely to slot 173', () => {
    // LOCAL's 173 is a different migration (173_phoenix_step_173.sql), so the
    // exception must not transfer to it -- even on the real 173 remote version.
    expect(expectedRemoteName(173, '173_phoenix_step_173.sql', '20260810200846')).toBe('173_phoenix_step_173');
    expectRefusal(
      () => reconcileMigrationHistory(
        productionShapedRows().map((r, i) => (i === 172 ? { ...r, name: 'phoenix_step_173' } : r)), LOCAL),
      'REMOTE_NAME_MISMATCH',
    );
  });

  it('binds the exception to the exact REMOTE VERSION: the real 173 name under any other version REFUSES', () => {
    // 20260810200847 is one second after the real row and still orders between
    // 172 and 174, so only the version binding can reject it.
    expect(expectedRemoteName(173, M173_FILENAME, '20260810200847'))
      .toBe('173_phoenix_database_security_surface_hardening');
    expectRefusal(
      () => reconcileMigrationHistory(
        realShapedRows({ 173: { version: '20260810200847', name: M173_NAME } }), REAL_LOCAL),
      'REMOTE_NAME_MISMATCH',
    );
  });

  it('expectedRemoteName returns the exception only for the exact triple', () => {
    expect(expectedRemoteName(173, M173_FILENAME, '20260810200846')).toBe(M173_NAME);
    // no remote version -> no exception can apply (fail closed)
    expect(expectedRemoteName(173, M173_FILENAME)).toBe('173_phoenix_database_security_surface_hardening');
    expect(expectedRemoteName(173, M173_FILENAME, null)).toBe('173_phoenix_database_security_surface_hardening');
    expect(expectedRemoteName(174, M174_FILENAME, stamp(1))).toBe('174_phoenix_authenticated_rpc_surface_hardening');
    expect(expectedRemoteName(197, '197_phoenix_public_execute_convergence.sql', '20260824010203'))
      .toBe('197_phoenix_public_execute_convergence');
  });
});

// ===========================================================================
// CANONICAL 214 AND PRODUCTION THROUGH 215 — the real state before M216.
//
// Executor run 35925796412 refused at canonical 214: Production records it as
// `fix_central_needs_review_readiness_volatility` under 20260914111813. The
// fixture below writes that row -- and the real 173 and 215 rows -- out
// LITERALLY, independent of HISTORICAL_REMOTE_NAME_EXCEPTIONS and of
// expectedRemoteName(), so these tests cannot agree with the code merely by
// construction.
// ===========================================================================
const M213_FILENAME = '213_phoenix_central_needs_beneficiary_column_mapping.sql';
const M214_FILENAME = '214_phoenix_central_needs_review_readiness_volatility.sql';
const M214_VERSION = '20260914111813';
const M214_NAME = 'fix_central_needs_review_readiness_volatility';
const M215_FILENAME = '215_phoenix_central_needs_governed_correction_lifecycle.sql';
const M215_VERSION = '20260922153813';
const M216_FILENAME = '216_phoenix_central_needs_region_persistence.sql';
// The PRE-DISPATCH fixture version the M216 rehearsal below was written with,
// kept as that historical record. It is NOT Production's M216 identity: the
// dispatch recorded 20260924124100 (see the sealed-216 block further down).
const M216_VERSION = '20260923215400';

/** Local catalogue 1..216 with the REAL filenames of 173, 174 and 213-216. */
const LOCAL_216 = Array.from({ length: 216 }, (_, i) => {
  const v = i + 1;
  const real: Record<number, string> = {
    173: M173_FILENAME, 174: M174_FILENAME, 213: M213_FILENAME, 214: M214_FILENAME, 215: M215_FILENAME, 216: M216_FILENAME,
  };
  return { version: v, filename: real[v] ?? `${String(v).padStart(3, '0')}_phoenix_step_${v}.sql` };
});

/** 174..213: synthetic 12-hour steps from 2026-08-11, strictly between the real 173 and 214 rows. */
const synthVersion = (canonical: number) =>
  new Date(Date.UTC(2026, 7, 11, 0, 0, 0) + (canonical - 174) * 43_200_000)
    .toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

/** Production through canonical 215: 172 three-digit rows + 43 timestamp rows = 215 rows. */
function productionThrough215(overrides: Record<number, { version?: string; name?: string }> = {}) {
  const rows: { version: string; name: string }[] = [];
  for (let i = 1; i <= 172; i++) rows.push({ version: String(i).padStart(3, '0'), name: `legacy_name_${i}` });
  for (let canonical = 173; canonical <= 215; canonical++) {
    let row: { version: string; name: string };
    if (canonical === 173) row = { version: '20260810200846', name: 'phoenix_database_security_surface_hardening' };
    else if (canonical === 214) row = { version: '20260914111813', name: 'fix_central_needs_review_readiness_volatility' };
    else if (canonical === 215) row = { version: '20260922153813', name: '215_phoenix_central_needs_governed_correction_lifecycle' };
    else row = { version: synthVersion(canonical), name: canonicalStem(LOCAL_216[canonical - 1].filename) };
    rows.push({ ...row, ...(overrides[canonical] ?? {}) });
  }
  return rows;
}

describe('historical remote-name exception — canonical 214, and Production through 215', () => {
  it('the fixture carries the real 173 / 214 / 215 rows literally, in strict timestamp order', () => {
    const rows = productionThrough215();
    expect(rows).toHaveLength(215);
    expect(rows.find((r) => r.version === '20260810200846')?.name).toBe('phoenix_database_security_surface_hardening');
    expect(rows.find((r) => r.version === '20260914111813')?.name).toBe('fix_central_needs_review_readiness_volatility');
    expect(rows.find((r) => r.version === '20260922153813')?.name).toBe('215_phoenix_central_needs_governed_correction_lifecycle');
    const stamped = rows.filter((r) => /^\d{14}$/.test(r.version)).map((r) => r.version);
    expect(stamped).toHaveLength(43);
    expect(new Set(stamped).size).toBe(43);
    expect([...stamped].sort()).toEqual(stamped);
    expect(synthVersion(213) < M214_VERSION).toBe(true);
  });

  it('Production-shaped history through 215 reconciles cleanly: ceiling 215, pendingCanonical === [216]', () => {
    const r = reconcileMigrationHistory(productionThrough215(), LOCAL_216);
    expect(r.numericRowCount).toBe(172);
    expect(r.timestampRowCount).toBe(43);
    expect(r.canonicalCeiling).toBe(215);
    expect(r.mapping).toHaveLength(215);
    expect(r.appliedCanonical).toEqual(Array.from({ length: 215 }, (_, i) => i + 1));
    expect(r.pendingCanonical).toEqual([216]);
    expect(r.mapping.find((m) => m.canonical === 173)).toMatchObject({ remoteVersion: '20260810200846', remoteName: M173_NAME });
    expect(r.mapping.find((m) => m.canonical === 214)).toMatchObject({ remoteVersion: M214_VERSION, remoteName: M214_NAME, era: 'timestamp' });
    expect(r.mapping.find((m) => m.canonical === 215))
      .toMatchObject({ remoteVersion: M215_VERSION, remoteName: '215_phoenix_central_needs_governed_correction_lifecycle' });
  });

  it('exact M214 triple PASSES', () => {
    expect(expectedRemoteName(214, M214_FILENAME, M214_VERSION)).toBe(M214_NAME);
  });

  it('REFUSES the real M214 name under a wrong remote version', () => {
    // each stays strictly between the synthetic 213 row and the real 215 row,
    // so ordering still places it at canonical 214 and only the version differs
    for (const version of ['20260914111814', '20260914111812', '20260913111813']) {
      expect(expectedRemoteName(214, M214_FILENAME, version)).toBe('214_phoenix_central_needs_review_readiness_volatility');
      expectRefusal(
        () => reconcileMigrationHistory(productionThrough215({ 214: { version, name: M214_NAME } }), LOCAL_216),
        'REMOTE_NAME_MISMATCH',
      );
    }
  });

  it('REFUSES the canonical-name substitution on the real M214 row — the exception is exact, not optional', () => {
    expectRefusal(
      () => reconcileMigrationHistory(
        productionThrough215({ 214: { name: '214_phoenix_central_needs_review_readiness_volatility' } }), LOCAL_216),
      'REMOTE_NAME_MISMATCH',
    );
  });

  it('REFUSES arbitrary alternative names for M214', () => {
    for (const name of [
      'fix_central_needs_review_readiness_volatility_v2', 'central_needs_review_readiness_volatility',
      'phoenix_central_needs_review_readiness_volatility', 'fix_central_needs_review_readiness',
      'FIX_CENTRAL_NEEDS_REVIEW_READINESS_VOLATILITY', ' fix_central_needs_review_readiness_volatility', '',
    ]) {
      expectRefusal(
        () => reconcileMigrationHistory(productionThrough215({ 214: { name } }), LOCAL_216),
        name === '' ? 'REMOTE_NAME_MISSING' : 'REMOTE_NAME_MISMATCH',
      );
    }
  });

  it('binds the M214 exception to the exact canonical FILENAME', () => {
    expect(expectedRemoteName(214, '214_phoenix_step_214.sql', M214_VERSION)).toBe('214_phoenix_step_214');
    const renamed = LOCAL_216.map((m) => (m.version === 214 ? { version: 214, filename: '214_phoenix_step_214.sql' } : m));
    expectRefusal(() => reconcileMigrationHistory(productionThrough215(), renamed), 'REMOTE_NAME_MISMATCH');
  });

  it('binds each exception to its exact canonical ORDINAL — the right filename and version at another ordinal get none', () => {
    // Filename and remote version both match an exception here; only the
    // canonical ordinal differs, so only the ordinal part of the triple can refuse.
    expect(expectedRemoteName(213, M214_FILENAME, M214_VERSION)).toBe('214_phoenix_central_needs_review_readiness_volatility');
    expect(expectedRemoteName(215, M214_FILENAME, M214_VERSION)).toBe('214_phoenix_central_needs_review_readiness_volatility');
    expect(expectedRemoteName('214' as unknown as number, M214_FILENAME, M214_VERSION))
      .toBe('214_phoenix_central_needs_review_readiness_volatility');
    expect(expectedRemoteName(172, M173_FILENAME, '20260810200846')).toBe('173_phoenix_database_security_surface_hardening');
    expect(expectedRemoteName(174, M173_FILENAME, '20260810200846')).toBe('173_phoenix_database_security_surface_hardening');
    expect(expectedRemoteName('173' as unknown as number, M173_FILENAME, '20260810200846'))
      .toBe('173_phoenix_database_security_surface_hardening');
  });

  it('neighbouring migrations inherit NO exception', () => {
    expect(expectedRemoteName(213, M213_FILENAME, M214_VERSION)).toBe('213_phoenix_central_needs_beneficiary_column_mapping');
    expect(expectedRemoteName(215, M215_FILENAME, M214_VERSION)).toBe('215_phoenix_central_needs_governed_correction_lifecycle');
    expect(expectedRemoteName(174, M174_FILENAME, '20260810200846')).toBe('174_phoenix_authenticated_rpc_surface_hardening');
    const cases: Array<[number, string]> = [[213, M214_NAME], [215, M214_NAME], [174, M173_NAME], [216, M214_NAME]];
    for (const [canonical, name] of cases) {
      const rows = canonical === 216
        ? [...productionThrough215(), { version: M216_VERSION, name }]
        : productionThrough215({ [canonical]: { name } });
      expectRefusal(() => reconcileMigrationHistory(rows, LOCAL_216), 'REMOTE_NAME_MISMATCH');
    }
  });

  it('does NOT silently accept a third unprefixed row', () => {
    for (const canonical of [175, 197, 213, 215]) {
      const stripped = canonicalStem(LOCAL_216[canonical - 1].filename).replace(/^\d{3}_/, '');
      expectRefusal(
        () => reconcileMigrationHistory(productionThrough215({ [canonical]: { name: stripped } }), LOCAL_216),
        'REMOTE_NAME_MISMATCH',
      );
    }
  });

  it('the exception table holds exactly the two proven events, and it and every entry are frozen', () => {
    expect(HISTORICAL_REMOTE_NAME_EXCEPTIONS).toHaveLength(2);
    expect(HISTORICAL_REMOTE_NAME_EXCEPTIONS).toEqual([
      { canonical: 173, canonicalFilename: M173_FILENAME, remoteVersion: '20260810200846', remoteName: M173_NAME },
      { canonical: 214, canonicalFilename: M214_FILENAME, remoteVersion: M214_VERSION, remoteName: M214_NAME },
    ]);
    expect(Object.isFrozen(HISTORICAL_REMOTE_NAME_EXCEPTIONS)).toBe(true);
    for (const e of HISTORICAL_REMOTE_NAME_EXCEPTIONS) expect(Object.isFrozen(e)).toBe(true);
    expect(() => { (HISTORICAL_REMOTE_NAME_EXCEPTIONS as unknown as object[]).push({}); }).toThrow(TypeError);
    expect(() => { (HISTORICAL_REMOTE_NAME_EXCEPTIONS[1] as { remoteVersion: string }).remoteVersion = '20990101000000'; })
      .toThrow(TypeError);
    expect(HISTORICAL_REMOTE_NAME_EXCEPTIONS[1].remoteVersion).toBe(M214_VERSION);
  });

  it('after M216 lands at its pinned version, post-apply acceptance reaches 216 with nothing pending', () => {
    const before = productionThrough215();
    expect(assertRemoteHistoryVersionUsable(M216_VERSION, before)).toBe(M216_VERSION);
    const after = [...before, { version: M216_VERSION, name: '216_phoenix_central_needs_region_persistence' }];
    const { reconciled, laterCatalogueTail } = assertPostApplyAcceptance({
      remoteRows: after,
      localMigrations: LOCAL_216,
      expectedCeiling: 216,
      expectedRemoteVersion: M216_VERSION,
      expectedName: '216_phoenix_central_needs_region_persistence',
      expectedRowCount: 216,
    });
    expect(reconciled.canonicalCeiling).toBe(216);
    expect(reconciled.pendingCanonical).toEqual([]);
    expect(laterCatalogueTail).toEqual([]);
  });

  it('refuses a pinned M216 version that is not strictly newer than the real M215 row', () => {
    expectRefusal(() => assertRemoteHistoryVersionUsable(M215_VERSION, productionThrough215()), 'TARGET_VERSION_ALREADY_PRESENT');
    expectRefusal(() => assertRemoteHistoryVersionUsable('20260922153812', productionThrough215()), 'TARGET_VERSION_NOT_NEWEST');
  });
});

// ===========================================================================
// PRODUCTION THROUGH THE SEALED 216 ROW — the real state before M217 (C5).
//
// The M216 block above rehearses the M216 dispatch with the pre-dispatch
// fixture version and is kept as that historical record. The dispatch itself
// (executor run 36026915933) recorded M216 as
//
//     version 20260924124100   name 216_phoenix_central_needs_region_persistence
//
// That SEALED row — prefixed, so no third name exception — is what Production
// carries now and what the M217 target must follow (C5 v1.9 §19). It is
// written out literally here, not derived from the code under test.
// ===========================================================================
const M216_SEALED_VERSION = '20260924124100';
const M216_NAME = '216_phoenix_central_needs_region_persistence';
const M217_FILENAME = '217_phoenix_central_needs_c5_safety_convergence.sql';
const M217_NAME = '217_phoenix_central_needs_c5_safety_convergence';
/** A fixture target strictly newer than the sealed row; a real dispatch generates it fresh. */
const M217_VERSION = '20260926120000';

/** Local catalogue 1..217: the 1..216 catalogue plus the canonical M217 file. */
const LOCAL_217 = [...LOCAL_216, { version: 217, filename: M217_FILENAME }];

/** Production through canonical 216: 172 three-digit rows + 44 timestamp rows = 216 rows. */
function productionThrough216(overrides: Record<number, { version?: string; name?: string }> = {}) {
  return [...productionThrough215(overrides), { version: M216_SEALED_VERSION, name: M216_NAME, ...(overrides[216] ?? {}) }];
}

describe('Production through the sealed 216 row — M217 pending', () => {
  it('the fixture carries the real 173 / 214 / 215 rows and the SEALED 216 row literally, in strict timestamp order', () => {
    const rows = productionThrough216();
    expect(rows).toHaveLength(216);
    expect(rows.at(-1)).toEqual({ version: '20260924124100', name: '216_phoenix_central_needs_region_persistence' });
    expect(rows.some((r) => r.version === M216_VERSION)).toBe(false); // the pre-dispatch fixture is not Production truth
    const stamped = rows.filter((r) => /^\d{14}$/.test(r.version)).map((r) => r.version);
    expect(stamped).toHaveLength(44);
    expect(new Set(stamped).size).toBe(44);
    expect([...stamped].sort()).toEqual(stamped);
    expect(M215_VERSION < M216_SEALED_VERSION && M216_SEALED_VERSION < M217_VERSION).toBe(true);
  });

  it('reconciles cleanly: ceiling 216, pendingCanonical === [217], the sealed row at canonical 216', () => {
    const r = reconcileMigrationHistory(productionThrough216(), LOCAL_217);
    expect(r.numericRowCount).toBe(172);
    expect(r.timestampRowCount).toBe(44);
    expect(r.canonicalCeiling).toBe(216);
    expect(r.appliedCanonical).toEqual(Array.from({ length: 216 }, (_, i) => i + 1));
    expect(r.pendingCanonical).toEqual([217]);
    expect(r.mapping.find((m) => m.canonical === 216)).toMatchObject({ remoteVersion: M216_SEALED_VERSION, remoteName: M216_NAME, era: 'timestamp' });
    expect(r.mapping.find((m) => m.canonical === 214)).toMatchObject({ remoteVersion: M214_VERSION, remoteName: M214_NAME });
    expect(r.mapping.find((m) => m.canonical === 173)).toMatchObject({ remoteVersion: '20260810200846', remoteName: M173_NAME });
  });

  it('the sealed 216 row needs no name exception; an unprefixed 216 or 217 row is still refused', () => {
    expect(expectedRemoteName(216, M216_FILENAME, M216_SEALED_VERSION)).toBe(M216_NAME);
    expect(HISTORICAL_REMOTE_NAME_EXCEPTIONS).toHaveLength(2);
    expectRefusal(() => reconcileMigrationHistory(productionThrough216({ 216: { name: 'phoenix_central_needs_region_persistence' } }), LOCAL_217),
      'REMOTE_NAME_MISMATCH');
    expectRefusal(() => reconcileMigrationHistory(
      [...productionThrough216(), { version: M217_VERSION, name: 'phoenix_central_needs_c5_safety_convergence' }], LOCAL_217),
    'REMOTE_NAME_MISMATCH');
  });

  it('the M217 remote_history_version must be strictly newer than the sealed 216 row', () => {
    expect(assertRemoteHistoryVersionUsable(M217_VERSION, productionThrough216())).toBe(M217_VERSION);
    expectRefusal(() => assertRemoteHistoryVersionUsable(M216_SEALED_VERSION, productionThrough216()), 'TARGET_VERSION_ALREADY_PRESENT');
    expectRefusal(() => assertRemoteHistoryVersionUsable('20260924124059', productionThrough216()), 'TARGET_VERSION_NOT_NEWEST');
    // the pre-dispatch fixture value is older than the sealed row, so it can never be reused as a target
    expectRefusal(() => assertRemoteHistoryVersionUsable(M216_VERSION, productionThrough216()), 'TARGET_VERSION_NOT_NEWEST');
  });

  it('after M217 lands at its pinned version, post-apply acceptance reaches 217 with nothing pending', () => {
    const after = [...productionThrough216(), { version: M217_VERSION, name: M217_NAME }];
    const { reconciled, laterCatalogueTail } = assertPostApplyAcceptance({
      remoteRows: after, localMigrations: LOCAL_217, expectedCeiling: 217,
      expectedRemoteVersion: M217_VERSION, expectedName: M217_NAME, expectedRowCount: 217,
    });
    expect(reconciled.canonicalCeiling).toBe(217);
    expect(reconciled.pendingCanonical).toEqual([]);
    expect(laterCatalogueTail).toEqual([]);
    expectRefusal(() => assertPostApplyAcceptance({
      remoteRows: productionThrough216(), localMigrations: LOCAL_217, expectedCeiling: 217,
      expectedRemoteVersion: M217_VERSION, expectedName: M217_NAME, expectedRowCount: 217,
    }), 'TARGET_ROW_NOT_SINGLE');
  });
});

// ===========================================================================
// POST-APPLY ACCEPTANCE — repository catalogue tail is informational, not an
// error.
//
// `verify-production-migration-applied.mjs` re-measures Production on a fresh
// connection after `supabase db push` and must accept a state where later,
// already-reviewed-and-merged migrations exist in this checkout's catalogue
// but have not run yet — that is expected, not drift. It must still refuse
// any migration at or before the pinned ceiling that is missing, duplicated,
// misnamed, gapped, or otherwise not cleanly applied exactly once.
// ===========================================================================
describe('post-apply acceptance — repository catalogue tail is informational', () => {
  /** A wider local manifest (1..210), independent of this file's own LOCAL
   *  (197) and of this repository's real migration count, so these scenarios
   *  can exercise ceilings past 203 without being tied to either. */
  const WIDE_LOCAL = Array.from({ length: 210 }, (_, i) => ({
    version: i + 1,
    filename: `${String(i + 1).padStart(3, '0')}_phoenix_step_${i + 1}.sql`,
  }));
  const CATALOGUE_208 = WIDE_LOCAL.slice(0, 208);

  /** Production applied through canonical `ceiling`: 172 numeric + the rest
   *  timestamped, using the same synthetic-name convention `productionShapedRows`
   *  falls back to past its own 197-entry LOCAL. */
  function appliedThrough(ceiling: number) {
    const rows: { version: string; name: string }[] = [];
    for (let i = 1; i <= 172; i++) rows.push({ version: String(i).padStart(3, '0'), name: `legacy_name_${i}` });
    for (let k = 0; k < ceiling - 172; k++) {
      const canonical = 172 + k + 1;
      rows.push({ version: stamp(k), name: `${canonical}_phoenix_step_${canonical}` });
    }
    return rows;
  }
  const targetVersionFor = (ceiling: number) => stamp(ceiling - 172 - 1);
  const targetNameFor = (ceiling: number) => `${ceiling}_phoenix_step_${ceiling}`;

  it('scenario 1 — applied through 203, catalogue to 208: PASS, [204..208] reported only as informational tail', () => {
    const ceiling = 203;
    const rows = appliedThrough(ceiling);
    const { reconciled, laterCatalogueTail } = assertPostApplyAcceptance({
      remoteRows: rows,
      localMigrations: CATALOGUE_208,
      expectedCeiling: ceiling,
      expectedRemoteVersion: targetVersionFor(ceiling),
      expectedName: targetNameFor(ceiling),
      expectedRowCount: rows.length,
    });
    expect(reconciled.canonicalCeiling).toBe(203);
    expect(laterCatalogueTail).toEqual([204, 205, 206, 207, 208]);
  });

  it('scenario 2 — target still absent after an alleged apply: FAIL', () => {
    const ceiling = 203;
    const rows = appliedThrough(ceiling - 1); // 203 never actually landed
    expectRefusal(() => assertPostApplyAcceptance({
      remoteRows: rows,
      localMigrations: CATALOGUE_208,
      expectedCeiling: ceiling,
      expectedRemoteVersion: targetVersionFor(ceiling),
      expectedName: targetNameFor(ceiling),
      expectedRowCount: null,
    }), 'TARGET_ROW_NOT_SINGLE');
  });

  it('scenario 3 — Production advanced beyond expected_next_ceiling: FAIL as drift', () => {
    const rows = appliedThrough(205); // actually at 205, pinned run only expected 203
    expectRefusal(() => assertPostApplyAcceptance({
      remoteRows: rows,
      localMigrations: CATALOGUE_208,
      expectedCeiling: 203,
      expectedRemoteVersion: targetVersionFor(203),
      expectedName: targetNameFor(203),
      expectedRowCount: null,
    }), 'CEILING_MISMATCH');
  });

  it('scenario 4a — exact history version missing entirely: FAIL', () => {
    const ceiling = 203;
    const rows = appliedThrough(ceiling - 1);
    expectRefusal(() => assertPostApplyAcceptance({
      remoteRows: rows,
      localMigrations: CATALOGUE_208,
      expectedCeiling: ceiling,
      expectedRemoteVersion: targetVersionFor(ceiling),
      expectedName: targetNameFor(ceiling),
      expectedRowCount: null,
    }), 'TARGET_ROW_NOT_SINGLE');
  });

  it('scenario 4b — exact history version duplicated: FAIL', () => {
    const ceiling = 203;
    const rows = appliedThrough(ceiling);
    rows.push({ ...rows[rows.length - 1] });
    expectRefusal(() => assertPostApplyAcceptance({
      remoteRows: rows,
      localMigrations: CATALOGUE_208,
      expectedCeiling: ceiling,
      expectedRemoteVersion: targetVersionFor(ceiling),
      expectedName: targetNameFor(ceiling),
      expectedRowCount: null,
    }), 'TARGET_ROW_NOT_SINGLE');
  });

  it('scenario 4c — exact history version mapped to the wrong migration: FAIL', () => {
    const ceiling = 203;
    const rows = appliedThrough(ceiling);
    const row = rows.find((r) => r.version === targetVersionFor(ceiling))!;
    row.name = 'not_the_pinned_migration';
    expectRefusal(() => assertPostApplyAcceptance({
      remoteRows: rows,
      localMigrations: CATALOGUE_208,
      expectedCeiling: ceiling,
      expectedRemoteVersion: targetVersionFor(ceiling),
      expectedName: targetNameFor(ceiling),
      expectedRowCount: null,
    }), 'TARGET_ROW_NAME_MISMATCH');
  });

  it('scenario 5 — an earlier unresolved gap in the applied history: FAIL', () => {
    const ceiling = 203;
    const rows = appliedThrough(ceiling).filter((r) => r.version !== '100');
    expectRefusal(() => assertPostApplyAcceptance({
      remoteRows: rows,
      localMigrations: CATALOGUE_208,
      expectedCeiling: ceiling,
      expectedRemoteVersion: targetVersionFor(ceiling),
      expectedName: targetNameFor(ceiling),
      expectedRowCount: null,
    }), 'REMOTE_NUMERIC_GAP');
  });

  it('scenario 6 — generic: applied ceiling 204 with [205..208] remaining: PASS (not hard-coded to 203)', () => {
    const ceiling = 204;
    const rows = appliedThrough(ceiling);
    const { laterCatalogueTail } = assertPostApplyAcceptance({
      remoteRows: rows,
      localMigrations: CATALOGUE_208,
      expectedCeiling: ceiling,
      expectedRemoteVersion: targetVersionFor(ceiling),
      expectedName: targetNameFor(ceiling),
      expectedRowCount: rows.length,
    });
    expect(laterCatalogueTail).toEqual([205, 206, 207, 208]);
  });

  it('scenario 7a — classifyPendingTail refuses to let the target itself sit in the informational tail', () => {
    const { blocking, laterCatalogueTail } = classifyPendingTail([203, 204, 205], 203);
    expect(blocking).toEqual([203]);
    expect(laterCatalogueTail).toEqual([204, 205]);
  });

  it('scenario 7b — end-to-end, the informational tail never contains the target itself, at every ceiling 203..208', () => {
    for (const ceiling of [203, 204, 205, 206, 207, 208]) {
      const rows = appliedThrough(ceiling);
      const { laterCatalogueTail } = assertPostApplyAcceptance({
        remoteRows: rows,
        localMigrations: CATALOGUE_208,
        expectedCeiling: ceiling,
        expectedRemoteVersion: targetVersionFor(ceiling),
        expectedName: targetNameFor(ceiling),
        expectedRowCount: null,
      });
      expect(laterCatalogueTail).not.toContain(ceiling);
      expect(laterCatalogueTail.every((v) => v > ceiling)).toBe(true);
    }
  });

  it('still refuses a remote row-count mismatch and a target reconciled off the pinned ceiling', () => {
    const ceiling = 203;
    const rows = appliedThrough(ceiling);
    expectRefusal(() => assertPostApplyAcceptance({
      remoteRows: rows,
      localMigrations: CATALOGUE_208,
      expectedCeiling: ceiling,
      expectedRemoteVersion: targetVersionFor(ceiling),
      expectedName: targetNameFor(ceiling),
      expectedRowCount: rows.length + 1,
    }), 'REMOTE_ROW_COUNT_MISMATCH');
  });
});
