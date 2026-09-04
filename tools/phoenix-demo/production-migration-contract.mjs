// ===========================================================================
// PINNED PRODUCTION MIGRATION EXECUTOR — the decision contract.
//
// This module holds ALL of the executor's refusal logic as PURE functions so
// every refusal is unit-testable without a database, a runner, or Production.
// The CLI wrapper (production-migration-preflight.mjs) only gathers inputs and
// calls decideProductionMigrationApply(); it makes no decision of its own.
//
// The executor exists because this repository had no generic-but-safe route to
// apply a migration to Production: the historical workflows each hardcode one
// specific migration number (147 / 146) and cannot carry M196+. Rather than
// weakening those into an unbounded `supabase db push`, this contract stays
// PINNED PER INVOCATION — every run must name the exact expected current
// ceiling, the exact next ceiling, the exact filename and the exact SHA-256,
// and every one of them must match measured reality before anything is applied.
//
// THE CENTRAL SAFETY PROOF
// ------------------------
// `supabase db push` applies EVERY migration in whatever directory it is
// pointed at; it has no "just this one" flag. So the executor never points it
// at the repository, and never relies on this contract's reasoning about the
// repository to limit it either. It is pointed at a SHADOW WORKSPACE
// (build-shadow-migration-workspace.mjs) built from exactly two things: the
// already-applied aliases Production's own history reports, plus the one
// migration this function names as `targetVersion`. That construction is what
// bounds the push to exactly one migration — proven independently, twice, by
// the two `supabase db push --dry-run` transcripts the workflow checks before
// and after the real push (assertDryRunNamesOnlyTarget).
//
// TWO NAMESPACES
// --------------
// This function reasons about two DIFFERENT things named "the local
// migrations", and conflating them was the cause of a real incident (run
// 33822028630, 2026-09-04): the REPOSITORY CATALOGUE (every file under
// supabase/migrations) may legitimately extend past the pinned target —
// several reviewed migrations routinely land in one PR before being applied
// one at a time — while the AUTHORIZED EXECUTION SET for THIS run is always
// exactly the applied aliases plus the one pinned target, regardless of how
// far the catalogue reaches. This function validates the catalogue is sound
// (unique, contiguous, no gaps) and that it contains the pinned target
// exactly once with the pinned name and hash; it does NOT require the
// catalogue to stop at the target, and does not compute the pending set from
// the whole catalogue as a gate. See the inline comments at steps 4 and 6.
//
// SECRETS: nothing here logs, returns, or embeds a connection string. The one
// function that touches it (assertProjectRefPinned) reads only its username
// and hostname and never puts either into a thrown message.
// ===========================================================================

/** The one Production project this executor may ever address. */
export const PINNED_PROJECT_REF = 'eyrzxgfkvqybjdgyphap';

/** The exact confirmation phrase an operator must type to dispatch a run. */
export const REQUIRED_CONFIRMATION = 'APPLY_PRODUCTION_MIGRATION';

/** Migration filenames this repository accepts: NNN_lower_snake_case.sql */
export const MIGRATION_FILENAME_PATTERN = /^(\d{3})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/**
 * The house banner that marks a migration as SQL-Editor-only. Matched loosely
 * on purpose: the repository carries 25 different wordings of it.
 */
export const MANUAL_APPLY_ONLY_PATTERN = /MANUAL APPLY ONLY/i;

/** True when a migration's own bytes forbid an automated push. */
export function declaresManualApplyOnly(sqlText) {
  return MANUAL_APPLY_ONLY_PATTERN.test(String(sqlText ?? ''));
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * A fail-closed refusal. `code` is stable and asserted by the unit tests, so a
 * future edit cannot quietly turn one refusal into a different one.
 */
export class ProductionMigrationRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductionMigrationRefusal';
    this.code = code;
  }
}

const refuse = (code, message) => {
  throw new ProductionMigrationRefusal(code, message);
};

/** Parse the leading numeric version out of a migration filename. */
export function parseMigrationVersion(filename) {
  const m = MIGRATION_FILENAME_PATTERN.exec(String(filename ?? ''));
  return m ? parseInt(m[1], 10) : null;
}

/** Integer-or-refuse for the two ceiling inputs, which arrive as strings. */
function toCeiling(value, label) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) {
    refuse('CEILING_MALFORMED', `${label} must be a plain positive integer, got ${JSON.stringify(s)}.`);
  }
  const n = parseInt(s, 10);
  if (n < 1) refuse('CEILING_MALFORMED', `${label} must be >= 1, got ${n}.`);
  return n;
}

/**
 * Assert an applied-history version list is sound: non-empty, strictly
 * increasing, no duplicates, and contiguous from 1 to its own highest.
 * A decision built on an already-inconsistent history is never safe.
 */
function assertSoundHistory(versions, label, codes) {
  if (!Array.isArray(versions) || versions.length === 0) {
    refuse(codes.empty, `${label} is empty — refusing to act on a history with no migrations at all.`);
  }
  for (const v of versions) {
    if (!Number.isInteger(v) || v < 1) {
      refuse(codes.notIncreasing, `${label} contains a non-positive-integer version ${JSON.stringify(v)}.`);
    }
  }
  for (let i = 1; i < versions.length; i++) {
    if (versions[i] <= versions[i - 1]) {
      refuse(
        codes.notIncreasing,
        `${label} is not strictly increasing at index ${i} (${versions[i - 1]} -> ${versions[i]}) — duplicate or out-of-order version.`,
      );
    }
  }
  const highest = versions[versions.length - 1];
  const seen = new Set(versions);
  const gaps = [];
  for (let n = 1; n <= highest; n++) if (!seen.has(n)) gaps.push(n);
  if (gaps.length > 0) {
    refuse(codes.gap, `${label} has gaps below its own highest version ${highest}: ${gaps.join(', ')}.`);
  }
  return highest;
}

/**
 * Prove the connection string addresses the one pinned Production project,
 * without ever reading — let alone emitting — its password.
 *
 * Supabase exposes the project ref in one of two shapes:
 *   pooler:  postgresql://postgres.<ref>:<pw>@aws-N-....pooler.supabase.com:5432/postgres
 *   direct:  postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres
 * Either is accepted; anything that carries neither is refused.
 */
export function assertProjectRefPinned(connectionString, expectedRef = PINNED_PROJECT_REF) {
  if (!connectionString) {
    refuse('PROJECT_REF_MISMATCH', 'No Production connection string was provided — refusing to guess a target.');
  }
  let url;
  try {
    url = new URL(String(connectionString));
  } catch {
    // Deliberately does not echo the string back.
    refuse('PROJECT_REF_MISMATCH', 'The Production connection string is not a parseable URL.');
  }
  let username = '';
  try {
    username = decodeURIComponent(url.username ?? '');
  } catch {
    username = String(url.username ?? '');
  }
  const host = String(url.hostname ?? '');
  const inUsername = username === `postgres.${expectedRef}` || username.endsWith(`.${expectedRef}`);
  const inHost = host === `db.${expectedRef}.supabase.co` || host.startsWith(`db.${expectedRef}.`);
  if (!inUsername && !inHost) {
    refuse(
      'PROJECT_REF_MISMATCH',
      `The Production connection string does not address project ref ${expectedRef} ` +
        '(checked the connection username and hostname only; no secret material is shown).',
    );
  }
  return expectedRef;
}

/**
 * THE decision. Returns { decision, targetVersion, pendingVersions,
 * remoteCeiling, localCeiling } or throws ProductionMigrationRefusal.
 *
 *   decision === 'APPLY'           -> exactly one pending migration, apply it
 *   decision === 'ALREADY_APPLIED' -> resume-safe: Production already carries
 *                                     exactly this migration and nothing else
 *
 * Every input is measured, never assumed. There is deliberately no "force",
 * no "skip", and no retry semantics anywhere in this function.
 */
export function decideProductionMigrationApply({
  branch,
  headSha,
  confirmSha,
  confirmation,
  projectRef,
  expectedProjectRef = PINNED_PROJECT_REF,
  expectedCurrentCeiling,
  expectedNextCeiling,
  migrationFilename,
  migrationSha256,
  localMigrations,
  remoteCanonical,
} = {}) {
  // ---- 1. Authorization envelope -----------------------------------------
  if (branch !== 'master') {
    refuse('NOT_MASTER', `This executor may run from master only, got ${JSON.stringify(branch ?? null)}.`);
  }
  if (!GIT_SHA_PATTERN.test(String(headSha ?? '')) || !GIT_SHA_PATTERN.test(String(confirmSha ?? ''))) {
    refuse('SHA_MALFORMED', 'Both the running commit SHA and the operator-supplied SHA must be full 40-hex commit SHAs.');
  }
  if (headSha !== confirmSha) {
    refuse('SHA_MISMATCH', `Operator confirmed ${confirmSha} but this run is at ${headSha} — refusing to apply from an unintended commit.`);
  }
  if (confirmation !== REQUIRED_CONFIRMATION) {
    refuse('CONFIRMATION_MISMATCH', `Confirmation phrase mismatch — expected exactly ${REQUIRED_CONFIRMATION}.`);
  }
  if (projectRef !== expectedProjectRef) {
    refuse('PROJECT_REF_MISMATCH', `Project ref ${JSON.stringify(projectRef ?? null)} is not the pinned Production ref ${expectedProjectRef}.`);
  }

  // ---- 2. The pinned ceiling pair ----------------------------------------
  const current = toCeiling(expectedCurrentCeiling, 'expected_current_ceiling');
  const next = toCeiling(expectedNextCeiling, 'expected_next_ceiling');
  if (next !== current + 1) {
    refuse('CEILING_NOT_CONSECUTIVE', `expected_next_ceiling must be exactly expected_current_ceiling + 1 (${current} + 1 = ${current + 1}), got ${next}.`);
  }

  // ---- 3. The pinned migration identity ----------------------------------
  const filename = String(migrationFilename ?? '');
  const prefix = parseMigrationVersion(filename);
  if (prefix === null) {
    refuse('FILENAME_MALFORMED', `migration_filename ${JSON.stringify(filename)} is not a NNN_lower_snake_case.sql migration filename.`);
  }
  if (prefix !== next) {
    refuse('FILENAME_PREFIX_MISMATCH', `migration_filename numeric prefix is ${prefix}, expected ${next}.`);
  }
  const sha256 = String(migrationSha256 ?? '').toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    refuse('SHA256_MALFORMED', 'migration_sha256 must be 64 lowercase hex characters.');
  }

  // ---- 4. Local checkout history -----------------------------------------
  // TWO NAMESPACES, NOT ONE, as of the 203-208 incident (run 33822028630):
  //
  //   REPOSITORY CATALOGUE  = every migration file in supabase/migrations.
  //     It may legitimately extend beyond `next` -- several migrations are
  //     routinely reviewed and merged together in one PR (204-208 alongside
  //     203 is the normal shape, not an anomaly). This block validates the
  //     catalogue is internally SOUND -- unique, strictly increasing, no gaps
  //     from 1 to its own highest -- and nothing more. `localCeiling` is that
  //     highest version, kept for observability only; it is never compared to
  //     `next`.
  //
  //   AUTHORIZED EXECUTION SET = the applied aliases (remoteCanonical.mapping)
  //     plus exactly this one pinned target. It is bounded by construction,
  //     not by a ceiling check here: buildShadowMigrationWorkspace() is handed
  //     only those two inputs and never iterates the catalogue beyond them, so
  //     204-208 sitting in the catalogue can never become eligible for a run
  //     pinned at 203 -- proven in build-shadow-migration-workspace.test.ts.
  //     The CLI is then run against that shadow workspace only, and its own
  //     dry-run transcript is independently checked (assertDryRunNamesOnlyTarget)
  //     to name the target and nothing else -- a second, live proof that does
  //     not depend on this function's reasoning at all.
  //
  // A prior revision required localCeiling === next, which conflated the two
  // namespaces and refused the ordinary, intended shape above with
  // LOCAL_CEILING_MISMATCH. That check is gone. What still refuses below --
  // unchanged -- is the checkout genuinely not containing the pinned target.
  if (!Array.isArray(localMigrations) || localMigrations.length === 0) {
    refuse('LOCAL_HISTORY_EMPTY', 'This checkout contains no migrations at all.');
  }
  const localSorted = [...localMigrations].sort((a, b) => a.version - b.version);
  const localCeiling = assertSoundHistory(
    localSorted.map((m) => m.version),
    'This checkout\'s migration set',
    { empty: 'LOCAL_HISTORY_EMPTY', notIncreasing: 'LOCAL_HISTORY_NOT_INCREASING', gap: 'LOCAL_HISTORY_GAP' },
  );

  const targets = localSorted.filter((m) => m.version === next);
  if (targets.length !== 1) {
    refuse('TARGET_MIGRATION_MISSING', `Expected exactly one local migration at version ${next}, found ${targets.length}.`);
  }
  const target = targets[0];
  if (target.filename !== filename) {
    refuse('TARGET_FILENAME_MISMATCH', `Local migration ${next} is ${JSON.stringify(target.filename)}, operator pinned ${JSON.stringify(filename)}.`);
  }
  if (String(target.sha256 ?? '').toLowerCase() !== sha256) {
    refuse(
      'TARGET_SHA256_MISMATCH',
      `Local ${filename} hashes to ${target.sha256}, operator pinned ${sha256}. ` +
        'The bytes on disk are not the bytes that were reviewed and certified.',
    );
  }
  // 143 of this repository's 195 migrations open with a "MANUAL APPLY ONLY.
  // DO NOT use `supabase db push`" banner — a convention that grew up precisely
  // BECAUSE no safe automated route existed. Migration 147, the one migration
  // written to be applied by a pinned workflow, carries no such banner. This
  // executor honours that distinction mechanically instead of by memory: a
  // migration whose own header forbids `supabase db push` is never pushed by
  // it, whatever the operator typed on the dispatch form.
  if (target.manualApplyOnly === true) {
    refuse(
      'MIGRATION_IS_MANUAL_APPLY_ONLY',
      `${filename} declares itself MANUAL APPLY ONLY and forbids \`supabase db push\`. ` +
        'This executor will not contradict a migration\'s own stated apply policy. A migration intended for ' +
        'this route must be authored without that banner.',
    );
  }

  // ---- 5. Production history, already reconciled --------------------------
  // remoteCanonical comes from reconcileMigrationHistory(): a total, one-to-one
  // canonical<->remote mapping, or that function has already refused.
  if (!remoteCanonical || !Number.isInteger(remoteCanonical.canonicalCeiling)) {
    refuse('REMOTE_HISTORY_EMPTY', 'No reconciled Production history was supplied.');
  }
  const remoteCeiling = remoteCanonical.canonicalCeiling;
  const remoteSet = new Set(remoteCanonical.appliedCanonical ?? []);
  if (remoteSet.size !== remoteCeiling) {
    refuse('REMOTE_HISTORY_NOT_INCREASING',
      `Reconciled history reports canonical ceiling ${remoteCeiling} but ${remoteSet.size} applied migrations.`);
  }
  if (remoteCeiling > next) {
    refuse(
      'REMOTE_FUTURE_MIGRATION',
      `Production is at canonical ${remoteCeiling}, beyond the pinned next version ${next}. ` +
        'This checkout is behind Production — refusing to act on an unexplained divergence.',
    );
  }

  // ---- 6. The decision -----------------------------------------------------
  // `pendingVersions` is CATALOGUE-minus-remote (production-migration-history's
  // pendingCanonical): with 204-208 legitimately unapplied alongside target
  // 203, it is [203,204,205,206,207,208], not [203] alone -- so it is kept
  // here purely for logging/observability and never gates the decision. The
  // single-pending guarantee this repository actually needs is proven on the
  // AUTHORIZED EXECUTION SET, not the catalogue: step 4 already proved the
  // checkout contains exactly one canonical file at `next` matching the
  // pinned name and hash; remoteSet (below) already proves whether `next` is
  // applied; and the shadow workspace + its two independent CLI dry-run
  // proofs (assertDryRunNamesOnlyTarget) bound the actual push to that one
  // migration regardless of how many later files sit in the catalogue.
  const pendingVersions = (remoteCanonical.pendingCanonical ?? []).slice().sort((a, b) => a - b);

  if (remoteCeiling === current && !remoteSet.has(next)) {
    return { decision: 'APPLY', targetVersion: next, pendingVersions, remoteCeiling, localCeiling };
  }

  if (remoteCeiling === next && remoteSet.has(next)) {
    return { decision: 'ALREADY_APPLIED', targetVersion: next, pendingVersions, remoteCeiling, localCeiling };
  }

  refuse(
    'UNEXPLAINED_STATE',
    `Production migration ceiling is ${remoteCeiling}. This invocation only knows how to proceed from exactly ` +
      `${current} (apply ${next}) or ${next} (already applied, resume-safe). Anything else is an unexplained ` +
      'divergence — stopping without applying, retrying, or repairing anything.',
  );
}

/**
 * SECOND, INDEPENDENT single-pending proof.
 *
 * decideProductionMigrationApply() proves the pending set from the database and
 * the directory listing. This proves the same thing from the Supabase CLI's own
 * mouth: `supabase db push --dry-run` prints the migrations it WOULD apply, so
 * its transcript must name the pinned migration and no other migration in this
 * checkout. Two independent proofs mean a silent change in either the CLI's
 * pending calculation or ours cannot get past the gate unnoticed.
 *
 * Fail-closed in both directions: a transcript that names an extra migration is
 * refused, and so is one that never names the target at all (which is what a
 * changed output format, or a push that would apply nothing, looks like).
 */
export function assertDryRunNamesOnlyTarget(transcript, { expectedFilename, allLocalFilenames } = {}) {
  const text = String(transcript ?? '');
  const target = String(expectedFilename ?? '');
  if (!MIGRATION_FILENAME_PATTERN.test(target)) {
    refuse('FILENAME_MALFORMED', `expectedFilename ${JSON.stringify(target)} is not a migration filename.`);
  }
  if (!text.includes(target)) {
    refuse(
      'DRY_RUN_TARGET_ABSENT',
      `The \`supabase db push --dry-run\` transcript never names ${target}. Either the CLI would apply nothing, ` +
        'or its output format changed and this proof can no longer be read — refusing either way.',
    );
  }

  // Any OTHER migration filename from this checkout appearing in the transcript
  // means the push would not be limited to the pinned one.
  const targetVersion = parseMigrationVersion(target);
  const others = (allLocalFilenames ?? [])
    .filter((f) => f !== target && parseMigrationVersion(f) !== targetVersion)
    .filter((f) => text.includes(f));
  if (others.length > 0) {
    refuse(
      'DRY_RUN_EXTRA_MIGRATION',
      `The \`supabase db push --dry-run\` transcript also names ${others.join(', ')} — the pending set is not ` +
        `exactly [${target}].`,
    );
  }

  // A bare version token on its own line (e.g. "196") is how some CLI versions
  // report a pending migration; any such token other than the target's is also
  // a refusal.
  const strayVersions = [...text.matchAll(/(?:^|\s)(\d{3})(?=\s|$)/gm)]
    .map((m) => parseInt(m[1], 10))
    .filter((v) => v !== targetVersion && (allLocalFilenames ?? []).some((f) => parseMigrationVersion(f) === v));
  if (strayVersions.length > 0) {
    refuse(
      'DRY_RUN_EXTRA_MIGRATION',
      `The \`supabase db push --dry-run\` transcript names other migration version(s) ${[...new Set(strayVersions)].join(', ')}.`,
    );
  }

  return { expectedFilename: target, targetVersion };
}
