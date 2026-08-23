/**
 * SHADOW MIGRATION WORKSPACE — builder and dry-run parser.
 *
 * The workspace is what the Supabase CLI is actually pointed at, so its
 * correctness is the difference between "one migration runs" and "twenty-five
 * migrations run". These tests pin the alias naming, the byte fidelity of every
 * alias, the containment rule, and the mechanical parsing of the CLI's answer.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ShadowWorkspaceRefusal,
  aliasFilenameFor,
  buildShadowMigrationWorkspace,
  parseDryRunPending,
} from '../build-shadow-migration-workspace.mjs';
import { reconcileMigrationHistory } from '../production-migration-history.mjs';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const scratch: string[] = [];
afterAll(() => { for (const d of scratch) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** A miniature canonical repo: 5 numeric-era + 3 timestamp-era + 1 pending. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-canon-'));
  scratch.push(dir);
  const local: { version: number; filename: string }[] = [];
  for (let i = 1; i <= 9; i++) {
    const f = `${String(i).padStart(3, '0')}_phoenix_step_${i}.sql`;
    writeFileSync(join(dir, f), `-- canonical migration ${i}\nSELECT ${i};\n`);
    local.push({ version: i, filename: f });
  }
  const stamp = (k: number) =>
    new Date(Date.UTC(2026, 7, 10, 20, 8, 46) + k * 7_200_000).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const rows = [
    ...[1, 2, 3, 4, 5].map((n) => ({ version: String(n).padStart(3, '0'), name: `legacy_${n}` })),
    ...[0, 1, 2].map((k) => ({ version: stamp(k), name: `${String(6 + k).padStart(3, '0')}_phoenix_step_${6 + k}` })),
  ];
  return { dir, local, rows };
}

describe('alias naming follows the CLI\'s own version/name split', () => {
  it('three-digit era: the canonical filename already IS the alias', () => {
    expect(aliasFilenameFor('001', '001_phoenix_core_schema.sql')).toBe('001_phoenix_core_schema.sql');
    expect(aliasFilenameFor('172', '172_phoenix_patient_dispensing_contract.sql'))
      .toBe('172_phoenix_patient_dispensing_contract.sql');
  });

  it('timestamp era: version prefixes the full canonical stem, matching Production', () => {
    // Production's row: version 20260823131150, name 196_phoenix_secdef_relation_schema_qualification
    expect(aliasFilenameFor('20260823131150', '196_phoenix_secdef_relation_schema_qualification.sql'))
      .toBe('20260823131150_196_phoenix_secdef_relation_schema_qualification.sql');
  });

  it('refuses a three-digit version that does not prefix its canonical stem', () => {
    let thrown: unknown;
    try { aliasFilenameFor('005', '007_phoenix_step_7.sql'); } catch (e) { thrown = e; }
    expect((thrown as ShadowWorkspaceRefusal).code).toBe('ALIAS_NUMERIC_PREFIX_MISMATCH');
  });
});

describe('workspace construction', () => {
  it('mirrors Production\'s namespace and adds exactly one target', () => {
    const { dir, local, rows } = fixture();
    const rec = reconcileMigrationHistory(rows, local);
    expect(rec.canonicalCeiling).toBe(8);
    expect(rec.pendingCanonical).toEqual([9]);

    const ws = buildShadowMigrationWorkspace({
      migrationsDir: dir, mapping: rec.mapping, localMigrations: local,
      target: { canonicalVersion: 9, filename: '009_phoenix_step_9.sql', remoteHistoryVersion: '20260823181015' },
    });
    scratch.push(ws.workspaceDir);

    const files = readdirSync(ws.migrationsDir).sort();
    expect(files).toHaveLength(9);
    expect(ws.aliasCount).toBe(8);
    expect(ws.targetAliasFilename).toBe('20260823181015_009_phoenix_step_9.sql');
    expect(files).toContain('001_phoenix_step_1.sql');
    expect(files).toContain(ws.targetAliasFilename);
    // every alias version is unique
    const versions = files.map((f) => /^(\d+)_/.exec(f)![1]);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('every alias carries the EXACT canonical bytes — the CLI can only run reviewed SQL', () => {
    const { dir, local, rows } = fixture();
    const rec = reconcileMigrationHistory(rows, local);
    const ws = buildShadowMigrationWorkspace({
      migrationsDir: dir, mapping: rec.mapping, localMigrations: local,
      target: { canonicalVersion: 9, filename: '009_phoenix_step_9.sql', remoteHistoryVersion: '20260823181015' },
    });
    scratch.push(ws.workspaceDir);
    for (const a of ws.aliases) {
      const canonical = local.find((l) => l.version === a.canonical)!;
      expect(sha(readFileSync(join(ws.migrationsDir, a.aliasName))))
        .toBe(sha(readFileSync(join(dir, canonical.filename))));
    }
    expect(sha(readFileSync(join(ws.migrationsDir, ws.targetAliasFilename))))
      .toBe(sha(readFileSync(join(dir, '009_phoenix_step_9.sql'))));
  });

  it('enforces the operator\'s pinned target hash', () => {
    const { dir, local, rows } = fixture();
    const rec = reconcileMigrationHistory(rows, local);
    let thrown: unknown;
    try {
      buildShadowMigrationWorkspace({
        migrationsDir: dir, mapping: rec.mapping, localMigrations: local,
        target: { canonicalVersion: 9, filename: '009_phoenix_step_9.sql', sha256: 'f'.repeat(64), remoteHistoryVersion: '20260823181015' },
      });
    } catch (e) { thrown = e; }
    expect((thrown as ShadowWorkspaceRefusal).code).toBe('TARGET_SHA256_MISMATCH');
  });

  it('refuses a target filename that is not the canonical one', () => {
    const { dir, local, rows } = fixture();
    const rec = reconcileMigrationHistory(rows, local);
    let thrown: unknown;
    try {
      buildShadowMigrationWorkspace({
        migrationsDir: dir, mapping: rec.mapping, localMigrations: local,
        target: { canonicalVersion: 9, filename: '009_something_else.sql', remoteHistoryVersion: '20260823181015' },
      });
    } catch (e) { thrown = e; }
    expect((thrown as ShadowWorkspaceRefusal).code).toBe('TARGET_FILENAME_MISMATCH');
  });

  it('refuses a target version that collides with applied history', () => {
    const { dir, local, rows } = fixture();
    const rec = reconcileMigrationHistory(rows, local);
    const applied = rec.mapping.find((m) => m.era === 'timestamp')!.remoteVersion;
    let thrown: unknown;
    try {
      buildShadowMigrationWorkspace({
        migrationsDir: dir, mapping: rec.mapping, localMigrations: local,
        target: { canonicalVersion: 9, filename: '009_phoenix_step_9.sql', remoteHistoryVersion: applied },
      });
    } catch (e) { thrown = e; }
    expect((thrown as ShadowWorkspaceRefusal).code).toBe('TARGET_VERSION_COLLIDES');
  });

  it('refuses to build inside the repository', () => {
    const { dir, local, rows } = fixture();
    const rec = reconcileMigrationHistory(rows, local);
    const inside = mkdtempSync(join(tmpdir(), 'phoenix-fakerepo-'));
    scratch.push(inside);
    mkdirSync(join(inside, 'nested'), { recursive: true });
    let thrown: unknown;
    try {
      buildShadowMigrationWorkspace({
        migrationsDir: dir, mapping: rec.mapping, localMigrations: local, rootDir: inside, repoRoot: inside,
        target: { canonicalVersion: 9, filename: '009_phoenix_step_9.sql', remoteHistoryVersion: '20260823181015' },
      });
    } catch (e) { thrown = e; }
    expect((thrown as ShadowWorkspaceRefusal).code).toBe('WORKSPACE_INSIDE_REPO');
  });
});

describe('dry-run output is parsed mechanically, never inferred', () => {
  it('extracts exactly the pending filenames from real CLI output shape', () => {
    const transcript = [
      'Connecting to remote database...',
      'Would push these migrations:',
      ' • 20260823181015_197_phoenix_public_execute_convergence.sql',
      'Finished supabase db push.',
    ].join('\n');
    expect(parseDryRunPending(transcript)).toEqual(['20260823181015_197_phoenix_public_execute_convergence.sql']);
  });

  it('sees every entry when more than one is pending — the dangerous case', () => {
    const transcript = 'Would push these migrations:\n • 001_a.sql\n • 20260823181015_197_b.sql\n';
    expect(parseDryRunPending(transcript)).toEqual(['001_a.sql', '20260823181015_197_b.sql']);
  });

  it('returns an empty list when nothing is pending', () => {
    expect(parseDryRunPending('Remote database is up to date.')).toEqual([]);
    expect(parseDryRunPending('')).toEqual([]);
  });
});
