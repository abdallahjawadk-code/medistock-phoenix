// ===========================================================================
// SHADOW MIGRATION WORKSPACE BUILDER.
//
// The Supabase CLI reasons in Production's OWN migration-version namespace.
// This repository's canonical directory uses 001..NNN filenames, but
// Production's history is 001..172 followed by 14-digit CLI timestamps. Point
// the CLI at the canonical directory and it computes a pending set of
// twenty-five migrations, because local `173` does not match remote
// `20260810200846`.
//
// So the CLI is never pointed at the repository. This builder writes a
// TEMPORARY workspace whose filenames reproduce Production's exact version
// namespace, and the CLI is run against it with `--workdir`. The pending set
// then collapses to exactly the one migration that is genuinely unapplied.
//
// INVARIANTS
//   - built only in OS temporary storage, never inside the repository;
//   - canonical migration files are read, never written or renamed;
//   - every alias carries the EXACT bytes of its canonical migration, so the
//     SQL the CLI would run is the SQL that was reviewed;
//   - the target alias is verified against the operator's pinned SHA-256;
//   - Production's schema_migrations is never written by this module.
// ===========================================================================
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { canonicalStem } from './production-migration-history.mjs';

export class ShadowWorkspaceRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ShadowWorkspaceRefusal';
    this.code = code;
  }
}
const refuse = (code, message) => { throw new ShadowWorkspaceRefusal(code, message); };

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The CLI derives a migration's version from the leading digits of its
 * filename and its name from the remainder. An alias is therefore just
 * `<remoteVersion>_<canonicalStem>.sql` — except in the three-digit era, where
 * the remote version already IS the canonical prefix and the alias filename is
 * the canonical filename verbatim.
 */
export function aliasFilenameFor(remoteVersion, canonicalFilename) {
  const stem = canonicalStem(canonicalFilename);
  if (/^\d{3}$/.test(remoteVersion)) {
    if (!stem.startsWith(`${remoteVersion}_`)) {
      refuse('ALIAS_NUMERIC_PREFIX_MISMATCH',
        `Three-digit remote version ${remoteVersion} does not prefix canonical stem ${JSON.stringify(stem)}.`);
    }
    return `${stem}.sql`;
  }
  return `${remoteVersion}_${stem}.sql`;
}

/**
 * Build the workspace.
 *
 * @param {object} o
 * @param {string} o.migrationsDir            canonical supabase/migrations
 * @param {Array}  o.mapping                  from reconcileMigrationHistory()
 * @param {Array}  o.localMigrations          [{version, filename}]
 * @param {object} o.target                   {canonicalVersion, filename, sha256, remoteHistoryVersion}
 * @param {string} [o.rootDir]                override temp root (tests only)
 * @param {string} [o.repoRoot]               repository root, to prove containment
 */
export function buildShadowMigrationWorkspace({
  migrationsDir, mapping, localMigrations, target, rootDir, repoRoot,
} = {}) {
  if (!migrationsDir) refuse('NO_MIGRATIONS_DIR', 'migrationsDir is required.');
  if (!Array.isArray(mapping) || mapping.length === 0) refuse('NO_MAPPING', 'A reconciled history mapping is required.');
  if (!target?.remoteHistoryVersion) refuse('NO_TARGET', 'A frozen target is required.');

  const base = rootDir ?? tmpdir();
  const workspaceDir = mkdtempSync(join(base, 'phoenix-shadow-'));

  // The workspace must never land inside the repository, or a generated alias
  // could be committed by accident.
  if (repoRoot) {
    const r = resolve(repoRoot) + sep;
    if (resolve(workspaceDir).startsWith(r)) {
      refuse('WORKSPACE_INSIDE_REPO', 'Refusing to build the shadow workspace inside the repository.');
    }
  }

  const migDir = join(workspaceDir, 'supabase', 'migrations');
  mkdirSync(migDir, { recursive: true });
  writeFileSync(join(workspaceDir, 'supabase', 'config.toml'),
    'project_id = "phoenix-shadow"\n', 'utf8');

  const byCanonical = new Map(localMigrations.map((m) => [m.version, m]));
  const seenVersion = new Set();
  const aliases = [];

  for (const m of mapping) {
    const local = byCanonical.get(m.canonical);
    if (!local) refuse('CANONICAL_SOURCE_MISSING', `No local migration for canonical ${m.canonical}.`);
    if (seenVersion.has(m.remoteVersion)) {
      refuse('SHADOW_DUPLICATE_VERSION', `Remote version ${m.remoteVersion} appears twice in the shadow set.`);
    }
    seenVersion.add(m.remoteVersion);

    const bytes = readFileSync(join(migrationsDir, local.filename));
    const aliasName = aliasFilenameFor(m.remoteVersion, local.filename);
    writeFileSync(join(migDir, aliasName), bytes);
    aliases.push({ canonical: m.canonical, remoteVersion: m.remoteVersion, aliasName, sha256: sha256(bytes) });
  }

  // ---- the one migration that is actually going to run --------------------
  const targetLocal = byCanonical.get(target.canonicalVersion);
  if (!targetLocal) refuse('TARGET_SOURCE_MISSING', `No local migration for canonical ${target.canonicalVersion}.`);
  if (targetLocal.filename !== target.filename) {
    refuse('TARGET_FILENAME_MISMATCH',
      `Canonical ${target.canonicalVersion} is ${JSON.stringify(targetLocal.filename)}, operator pinned ${JSON.stringify(target.filename)}.`);
  }
  if (seenVersion.has(target.remoteHistoryVersion)) {
    refuse('TARGET_VERSION_COLLIDES', `Target remote version ${target.remoteHistoryVersion} already exists in the shadow set.`);
  }

  const targetBytes = readFileSync(join(migrationsDir, targetLocal.filename));
  const targetSha = sha256(targetBytes);
  if (target.sha256 && targetSha !== String(target.sha256).toLowerCase()) {
    refuse('TARGET_SHA256_MISMATCH',
      `${targetLocal.filename} hashes to ${targetSha}, operator pinned ${target.sha256}.`);
  }
  const targetAliasFilename = aliasFilenameFor(target.remoteHistoryVersion, targetLocal.filename);
  writeFileSync(join(migDir, targetAliasFilename), targetBytes);

  // ---- the workspace must contain exactly applied + 1 ---------------------
  const total = aliases.length + 1;
  if (total !== mapping.length + 1) {
    refuse('SHADOW_COUNT_MISMATCH', `Shadow workspace holds ${total} migrations, expected ${mapping.length + 1}.`);
  }

  return {
    workspaceDir,
    migrationsDir: migDir,
    aliasCount: aliases.length,
    aliases,
    targetAliasFilename,
    targetAliasSha256: targetSha,
    totalMigrations: total,
  };
}

/**
 * Parse `supabase db push --dry-run` output into the exact pending filenames.
 * Mechanical, not visual: the executor asserts on this list rather than on a
 * human reading the log.
 */
export function parseDryRunPending(transcript) {
  const text = String(transcript ?? '');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:[•*-]\s*)?(\d{3,14}_[A-Za-z0-9_.-]+\.sql)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}
