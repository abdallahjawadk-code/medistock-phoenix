// ===========================================================================
// PRODUCTION MIGRATION HISTORY — canonical <-> Supabase reconciliation.
//
// WHY THIS EXISTS
// ---------------
// Production's supabase_migrations.schema_migrations does NOT hold this
// repository's canonical 001..NNN numbering. It holds TWO namespaces:
//
//   001 .. 172   direct three-digit versions   (the original numbering era)
//   173 ..       fourteen-digit TIMESTAMP versions written by the Supabase CLI
//
// The previous executor assumed one namespace and cast `version::int`. Against
// a real timestamp version that overflows int4 and the read fails outright
// (`value "20260810200846" is out of range for type integer`). Worse, even a
// widened cast would be wrong: the "contiguous 1..N, no gaps" proof the
// single-pending guarantee rested on is meaningless once versions stop being
// ordinals. The canonical ceiling is not MAX(version), not the row count, and
// not any arithmetic on the version column — it must be RECONCILED.
//
// WHAT THIS MODULE GUARANTEES
// ---------------------------
// Given the local canonical migration manifest and the remote history rows, it
// either produces a total, unambiguous, one-to-one mapping between them, or it
// refuses. Every remote row must map to exactly one canonical migration and
// every applied canonical migration to exactly one remote row. Ambiguity is
// never resolved by preference; it is a refusal.
//
// Remote versions are treated as TEXT throughout. Nothing here casts them to a
// number, and nothing compares them numerically.
// ===========================================================================

/** Direct three-digit era: the version IS the canonical ordinal. */
export const NUMERIC_VERSION_PATTERN = /^\d{3}$/;
/** Supabase CLI era: an opaque, strictly increasing 14-digit stamp. */
export const TIMESTAMP_VERSION_PATTERN = /^\d{14}$/;

export class MigrationHistoryRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrationHistoryRefusal';
    this.code = code;
  }
}

const refuse = (code, message) => {
  throw new MigrationHistoryRefusal(code, message);
};

/**
 * A 14-digit stamp must also be a real UTC instant. `20261332000000` matches
 * the shape but is not a date, and a Production executor must not accept it.
 */
export function isValidTimestampVersion(v) {
  if (!TIMESTAMP_VERSION_PATTERN.test(String(v ?? ''))) return false;
  const s = String(v);
  const [y, mo, d, h, mi, sec] = [
    +s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8),
    +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14),
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
      && dt.getUTCHours() === h && dt.getUTCMinutes() === mi && dt.getUTCSeconds() === sec;
}

/** The canonical filename stem, i.e. `197_phoenix_public_execute_convergence`. */
export const canonicalStem = (filename) => String(filename ?? '').replace(/\.sql$/i, '');

/**
 * Reconcile remote history against the local canonical manifest.
 *
 * @param {{version:string,name:string}[]} remoteRows
 * @param {{version:number,filename:string}[]} localMigrations  full local set
 * @returns {{canonicalCeiling:number, mapping:Array, appliedCanonical:number[],
 *            pendingCanonical:number[], numericRowCount:number,
 *            timestampRowCount:number, transitionVersion:string|null}}
 */
export function reconcileMigrationHistory(remoteRows, localMigrations) {
  if (!Array.isArray(remoteRows) || remoteRows.length === 0) {
    refuse('REMOTE_HISTORY_EMPTY', 'Production migration history is empty — refusing to reason about it.');
  }
  if (!Array.isArray(localMigrations) || localMigrations.length === 0) {
    refuse('LOCAL_MANIFEST_EMPTY', 'The local canonical migration manifest is empty.');
  }

  // ---- 1. Remote versions are unique and of a recognised shape ------------
  const seen = new Set();
  for (const r of remoteRows) {
    const v = String(r?.version ?? '');
    if (seen.has(v)) refuse('REMOTE_DUPLICATE_VERSION', `Production history contains duplicate version ${JSON.stringify(v)}.`);
    seen.add(v);
    if (!NUMERIC_VERSION_PATTERN.test(v) && !TIMESTAMP_VERSION_PATTERN.test(v)) {
      refuse('REMOTE_VERSION_SHAPE', `Production history contains version ${JSON.stringify(v)}, which is neither a 3-digit ordinal nor a 14-digit timestamp.`);
    }
    if (TIMESTAMP_VERSION_PATTERN.test(v) && !isValidTimestampVersion(v)) {
      refuse('REMOTE_TIMESTAMP_INVALID', `Production history version ${JSON.stringify(v)} is 14 digits but not a valid UTC instant.`);
    }
  }

  const numeric = remoteRows.filter((r) => NUMERIC_VERSION_PATTERN.test(String(r.version)))
    .sort((a, b) => String(a.version).localeCompare(String(b.version)));
  const stamped = remoteRows.filter((r) => TIMESTAMP_VERSION_PATTERN.test(String(r.version)))
    .sort((a, b) => String(a.version).localeCompare(String(b.version)));

  // ---- 2. The numeric era is contiguous from 001 --------------------------
  if (numeric.length === 0) {
    refuse('REMOTE_NUMERIC_ERA_MISSING', 'Production history has no 3-digit era at all — the expected shape starts at 001.');
  }
  numeric.forEach((r, i) => {
    const expected = String(i + 1).padStart(3, '0');
    if (String(r.version) !== expected) {
      refuse('REMOTE_NUMERIC_GAP', `Production 3-digit era is not contiguous: position ${i + 1} is ${JSON.stringify(String(r.version))}, expected ${expected}.`);
    }
  });

  // ---- 3. Timestamps are strictly increasing ------------------------------
  for (let i = 1; i < stamped.length; i++) {
    if (String(stamped[i].version) <= String(stamped[i - 1].version)) {
      refuse('REMOTE_TIMESTAMP_ORDER', `Production timestamp era is not strictly increasing at ${JSON.stringify(String(stamped[i].version))}.`);
    }
  }

  // ---- 4. Assign canonical ordinals ---------------------------------------
  // The numeric era is self-identifying: version '057' IS canonical 57.
  // The timestamp era carries no ordinal, so it is assigned by ascending
  // timestamp — and then INDEPENDENTLY re-checked against the name below, so
  // ordering alone never decides identity.
  const localByVersion = new Map(localMigrations.map((m) => [m.version, m]));
  const mapping = [];
  numeric.forEach((r, i) => mapping.push({ canonical: i + 1, remoteVersion: String(r.version), remoteName: r.name ?? null, era: 'numeric' }));
  stamped.forEach((r, i) => mapping.push({ canonical: numeric.length + i + 1, remoteVersion: String(r.version), remoteName: r.name ?? null, era: 'timestamp' }));

  const canonicalCeiling = mapping.length;

  // ---- 5. Every mapped canonical migration must exist locally -------------
  for (const m of mapping) {
    if (!localByVersion.has(m.canonical)) {
      refuse('CANONICAL_MIGRATION_MISSING_LOCALLY', `Production has an applied migration mapped to canonical ${m.canonical}, but no such migration exists in this checkout.`);
    }
  }

  // ---- 6. Timestamp-era names must independently confirm the ordinal ------
  // This is the second, non-order-based identity proof. The 3-digit era is NOT
  // name-checked: its historical `name` convention is not established by any
  // evidence available here, and its version already fixes identity exactly.
  for (const m of mapping) {
    if (m.era !== 'timestamp') continue;
    const local = localByVersion.get(m.canonical);
    const stem = canonicalStem(local.filename);
    if (m.remoteName === null || m.remoteName === undefined || m.remoteName === '') {
      refuse('REMOTE_NAME_MISSING', `Production timestamp row ${m.remoteVersion} has no name, so its canonical identity cannot be independently confirmed.`);
    }
    if (m.remoteName !== stem) {
      refuse('REMOTE_NAME_MISMATCH', `Production row ${m.remoteVersion} is named ${JSON.stringify(m.remoteName)}, but ordering places it at canonical ${m.canonical} whose local stem is ${JSON.stringify(stem)}.`);
    }
  }

  // ---- 7. Totality and one-to-one -----------------------------------------
  if (mapping.length !== remoteRows.length) {
    refuse('REMOTE_ROW_UNMAPPED', `Reconciled ${mapping.length} rows but Production reported ${remoteRows.length}.`);
  }
  const canonicalSeen = new Set();
  for (const m of mapping) {
    if (canonicalSeen.has(m.canonical)) refuse('CANONICAL_DUPLICATE', `Canonical migration ${m.canonical} is mapped more than once.`);
    canonicalSeen.add(m.canonical);
  }
  for (let n = 1; n <= canonicalCeiling; n++) {
    if (!canonicalSeen.has(n)) refuse('CANONICAL_GAP', `Canonical migration ${n} is missing from the reconciled Production history.`);
  }

  // ---- 8. No applied migration beyond what this checkout knows ------------
  const localCeiling = Math.max(...localMigrations.map((m) => m.version));
  if (canonicalCeiling > localCeiling) {
    refuse('REMOTE_AHEAD_OF_LOCAL', `Production is at canonical ${canonicalCeiling} but this checkout only reaches ${localCeiling}.`);
  }

  const appliedCanonical = mapping.map((m) => m.canonical).sort((a, b) => a - b);
  const pendingCanonical = localMigrations.map((m) => m.version)
    .filter((v) => !canonicalSeen.has(v)).sort((a, b) => a - b);

  return {
    canonicalCeiling,
    mapping,
    appliedCanonical,
    pendingCanonical,
    numericRowCount: numeric.length,
    timestampRowCount: stamped.length,
    transitionVersion: stamped.length ? String(stamped[0].version) : null,
  };
}

/**
 * Choose the remote-history version a NEW migration will be recorded under.
 * It is supplied by the operator (frozen per invocation), never invented here,
 * and must be a valid instant strictly newer than everything already applied.
 */
export function assertRemoteHistoryVersionUsable(remoteHistoryVersion, remoteRows) {
  const v = String(remoteHistoryVersion ?? '');
  if (!TIMESTAMP_VERSION_PATTERN.test(v)) {
    refuse('TARGET_VERSION_SHAPE', `remote_history_version ${JSON.stringify(v)} must be exactly 14 digits.`);
  }
  if (!isValidTimestampVersion(v)) {
    refuse('TARGET_VERSION_INVALID', `remote_history_version ${JSON.stringify(v)} is not a valid UTC instant.`);
  }
  for (const r of remoteRows) {
    if (String(r.version) === v) {
      refuse('TARGET_VERSION_ALREADY_PRESENT', `remote_history_version ${v} is already present in Production history.`);
    }
  }
  const maxExisting = remoteRows
    .map((r) => String(r.version))
    .filter((x) => TIMESTAMP_VERSION_PATTERN.test(x))
    .sort()
    .pop();
  if (maxExisting && v <= maxExisting) {
    refuse('TARGET_VERSION_NOT_NEWEST', `remote_history_version ${v} is not strictly greater than the newest applied timestamp ${maxExisting}.`);
  }
  return v;
}
