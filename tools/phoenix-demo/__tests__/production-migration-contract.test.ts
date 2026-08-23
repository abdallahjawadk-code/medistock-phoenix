/**
 * PINNED PRODUCTION MIGRATION EXECUTOR — negative-control matrix.
 *
 * Stage I / I-2. Pure unit test over
 * tools/phoenix-demo/production-migration-contract.mjs — no database, no
 * runner, no Production, no network. Every refusal the executor is required to
 * make is exercised here by scenario, and asserted by its stable `code` so a
 * later edit cannot quietly turn one refusal into a different (or weaker) one.
 *
 * The baseline scenario throughout is the real Stage-I shape: this checkout
 * carries migrations 1..196, Production carries 1..195, and the operator pins
 * 195 -> 196.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  PINNED_PROJECT_REF,
  REQUIRED_CONFIRMATION,
  ProductionMigrationRefusal,
  assertDryRunNamesOnlyTarget,
  assertProjectRefPinned,
  declaresManualApplyOnly,
  decideProductionMigrationApply,
  parseMigrationVersion,
} from '../production-migration-contract.mjs';

const HEAD = 'a'.repeat(40);
const TARGET_FILE = '196_phoenix_secdef_relation_qualification.sql';
const TARGET_SHA = 'b'.repeat(64);

/** A contiguous local migration set 1..ceiling, with 196 as the pinned target. */
function localSet(ceiling: number, overrides: Record<number, { filename?: string; sha256?: string }> = {}) {
  const out = [];
  for (let v = 1; v <= ceiling; v++) {
    const o = overrides[v] ?? {};
    out.push({
      version: v,
      filename: o.filename ?? (v === 196 ? TARGET_FILE : `${String(v).padStart(3, '0')}_phoenix_step_${v}.sql`),
      sha256: o.sha256 ?? (v === 196 ? TARGET_SHA : String(v).padStart(64, '0')),
    });
  }
  return out;
}

/** A contiguous applied history 1..ceiling. */
const remoteSet = (ceiling: number) => Array.from({ length: ceiling }, (_, i) => i + 1);

const baseline = () => ({
  branch: 'master',
  headSha: HEAD,
  confirmSha: HEAD,
  confirmation: REQUIRED_CONFIRMATION,
  projectRef: PINNED_PROJECT_REF,
  expectedCurrentCeiling: '195',
  expectedNextCeiling: '196',
  migrationFilename: TARGET_FILE,
  migrationSha256: TARGET_SHA,
  localMigrations: localSet(196),
  remoteVersions: remoteSet(195),
});

/** Assert the call refuses, and refuses with exactly this code. */
function expectRefusal(input: Record<string, unknown>, code: string) {
  let thrown: unknown;
  try {
    decideProductionMigrationApply(input as never);
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `expected a refusal with code ${code}, got none`).toBeInstanceOf(ProductionMigrationRefusal);
  expect((thrown as ProductionMigrationRefusal).code).toBe(code);
  return thrown as ProductionMigrationRefusal;
}

describe('production migration executor — the happy path is exactly one pending migration', () => {
  it('APPLIES when Production is at 195, this checkout is at 196, and every pin matches', () => {
    const out = decideProductionMigrationApply(baseline() as never);
    expect(out).toEqual({
      decision: 'APPLY',
      targetVersion: 196,
      pendingVersions: [196],
      remoteCeiling: 195,
      localCeiling: 196,
    });
  });

  it('accepts the pinned hash in upper case, normalizing rather than refusing on case alone', () => {
    const out = decideProductionMigrationApply({ ...baseline(), migrationSha256: TARGET_SHA.toUpperCase() } as never);
    expect(out.decision).toBe('APPLY');
  });

  it('is RESUME-SAFE: re-dispatching after a successful apply reports ALREADY_APPLIED instead of pushing again', () => {
    const out = decideProductionMigrationApply({ ...baseline(), remoteVersions: remoteSet(196) } as never);
    expect(out.decision).toBe('ALREADY_APPLIED');
    expect(out.pendingVersions).toEqual([]);
    expect(out.remoteCeiling).toBe(196);
  });
});

describe('production migration executor — negative controls (every one must fail closed)', () => {
  it('wrong branch', () => {
    expectRefusal({ ...baseline(), branch: 'codex/i3-m196-secdef-schema-qualification' }, 'NOT_MASTER');
    expectRefusal({ ...baseline(), branch: undefined }, 'NOT_MASTER');
  });

  it('wrong master SHA — the operator confirmed a different commit than the one running', () => {
    expectRefusal({ ...baseline(), confirmSha: 'c'.repeat(40) }, 'SHA_MISMATCH');
  });

  it('malformed SHA — a short SHA is never accepted as "close enough"', () => {
    expectRefusal({ ...baseline(), confirmSha: 'abc1234', headSha: 'abc1234' }, 'SHA_MALFORMED');
  });

  it('wrong confirmation phrase', () => {
    expectRefusal({ ...baseline(), confirmation: 'apply_production_migration' }, 'CONFIRMATION_MISMATCH');
    expectRefusal({ ...baseline(), confirmation: 'APPLY_PRODUCTION_MIGRATION ' }, 'CONFIRMATION_MISMATCH');
    expectRefusal({ ...baseline(), confirmation: '' }, 'CONFIRMATION_MISMATCH');
  });

  it('wrong project ref — no invocation may address any project but the pinned one', () => {
    expectRefusal({ ...baseline(), projectRef: 'someotherprojectref00' }, 'PROJECT_REF_MISMATCH');
  });

  it('wrong next ceiling — next must be exactly current + 1, never a jump or a repeat', () => {
    expectRefusal({ ...baseline(), expectedNextCeiling: '197' }, 'CEILING_NOT_CONSECUTIVE');
    expectRefusal({ ...baseline(), expectedNextCeiling: '195' }, 'CEILING_NOT_CONSECUTIVE');
    expectRefusal({ ...baseline(), expectedCurrentCeiling: '190' }, 'CEILING_NOT_CONSECUTIVE');
  });

  it('malformed ceilings', () => {
    expectRefusal({ ...baseline(), expectedCurrentCeiling: '195.0' }, 'CEILING_MALFORMED');
    expectRefusal({ ...baseline(), expectedNextCeiling: 'latest' }, 'CEILING_MALFORMED');
    expectRefusal({ ...baseline(), expectedCurrentCeiling: '0', expectedNextCeiling: '1' }, 'CEILING_MALFORMED');
  });

  it('wrong filename — a name whose numeric prefix is not the pinned next version', () => {
    expectRefusal({ ...baseline(), migrationFilename: '197_phoenix_something.sql' }, 'FILENAME_PREFIX_MISMATCH');
  });

  it('malformed filename — no paths, no wildcards, no arbitrary SQL file', () => {
    for (const bad of [
      '../../etc/passwd',
      'supabase/migrations/196_phoenix_x.sql',
      '196_phoenix_x.sql; DROP TABLE profiles',
      '196-phoenix-x.sql',
      '*.sql',
      '',
    ]) {
      expectRefusal({ ...baseline(), migrationFilename: bad }, 'FILENAME_MALFORMED');
    }
  });

  it('wrong filename at the right version — the pinned name is not the file actually sitting at 196', () => {
    const r = expectRefusal(
      { ...baseline(), migrationFilename: '196_phoenix_a_different_migration.sql' },
      'TARGET_FILENAME_MISMATCH',
    );
    expect(r.message).toContain(TARGET_FILE);
  });

  it('wrong hash', () => {
    expectRefusal({ ...baseline(), migrationSha256: 'd'.repeat(64) }, 'TARGET_SHA256_MISMATCH');
  });

  it('malformed hash', () => {
    expectRefusal({ ...baseline(), migrationSha256: 'not-a-hash' }, 'SHA256_MALFORMED');
    expectRefusal({ ...baseline(), migrationSha256: 'b'.repeat(63) }, 'SHA256_MALFORMED');
    // Upper-case input is normalized before comparison, so a WRONG upper-case
    // hash still refuses on its value rather than slipping past on its case.
    expectRefusal({ ...baseline(), migrationSha256: 'D'.repeat(64) }, 'TARGET_SHA256_MISMATCH');
  });

  it('altered migration bytes — the file on disk is no longer the reviewed file', () => {
    const tampered = localSet(196, { 196: { sha256: 'e'.repeat(64) } });
    const r = expectRefusal({ ...baseline(), localMigrations: tampered }, 'TARGET_SHA256_MISMATCH');
    expect(r.message).toContain('not the bytes that were reviewed');
  });

  it('two pending migrations — a checkout carrying 197 as well can never push "just" 196', () => {
    const r = expectRefusal(
      { ...baseline(), localMigrations: localSet(197), remoteVersions: remoteSet(195) },
      'LOCAL_CEILING_MISMATCH',
    );
    expect(r.message).toContain('could push more than one migration');
  });

  it('unexpected local future migration — same guard, stated as the operator would hit it', () => {
    expectRefusal({ ...baseline(), localMigrations: localSet(198) }, 'LOCAL_CEILING_MISMATCH');
  });

  it('no pending migration and no resume story — the checkout does not even contain the pinned version', () => {
    expectRefusal({ ...baseline(), localMigrations: localSet(195) }, 'LOCAL_CEILING_MISMATCH');
  });

  it('unexpected Production future migration — this checkout is behind Production', () => {
    const r = expectRefusal({ ...baseline(), remoteVersions: remoteSet(197) }, 'REMOTE_FUTURE_MIGRATION');
    expect(r.message).toContain('197');
  });

  it('wrong current ceiling — Production is not where the operator claimed it was', () => {
    const r = expectRefusal({ ...baseline(), remoteVersions: remoteSet(194) }, 'UNEXPLAINED_STATE');
    expect(r.message).toContain('194');
    expect(r.message).toContain('without applying, retrying, or repairing');
  });

  it('migration number gap — locally', () => {
    const gapped = localSet(196).filter((m) => m.version !== 100);
    expectRefusal({ ...baseline(), localMigrations: gapped }, 'LOCAL_HISTORY_GAP');
  });

  it('migration number gap — in Production', () => {
    const gapped = remoteSet(195).filter((v) => v !== 100);
    expectRefusal({ ...baseline(), remoteVersions: gapped }, 'REMOTE_HISTORY_GAP');
  });

  it('duplicated Production history version', () => {
    expectRefusal({ ...baseline(), remoteVersions: [...remoteSet(195), 195] }, 'REMOTE_HISTORY_NOT_INCREASING');
  });

  it('empty histories', () => {
    expectRefusal({ ...baseline(), localMigrations: [] }, 'LOCAL_HISTORY_EMPTY');
    expectRefusal({ ...baseline(), remoteVersions: [] }, 'REMOTE_HISTORY_EMPTY');
  });

  // PENDING_SET_NOT_SINGLE is a deliberate defensive backstop rather than a
  // reachable state: local and remote histories are both required to be
  // contiguous first, which already forces local-minus-remote to be exactly
  // [next] on the APPLY path and [] on the resume path. It is asserted here as
  // an existing guard, not claimed as covered behaviour.
  it('keeps the defensive single-pending backstop in place', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../production-migration-contract.mjs', import.meta.url), 'utf8'),
    );
    expect(src).toContain("'PENDING_SET_NOT_SINGLE'");
    expect(src).toContain('applies every pending migration');
  });
});

describe('production migration executor — the connection string is pinned, and never leaked', () => {
  const POOLER = `postgresql://postgres.${PINNED_PROJECT_REF}:s3cr3tpassw0rd@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`;
  const DIRECT = `postgresql://postgres:s3cr3tpassw0rd@db.${PINNED_PROJECT_REF}.supabase.co:5432/postgres`;
  const WRONG = 'postgresql://postgres.someotherproject:s3cr3tpassw0rd@aws-1-ap-south-1.pooler.supabase.com:5432/postgres';

  it('accepts both Supabase connection shapes for the pinned project', () => {
    expect(assertProjectRefPinned(POOLER)).toBe(PINNED_PROJECT_REF);
    expect(assertProjectRefPinned(DIRECT)).toBe(PINNED_PROJECT_REF);
  });

  it('refuses a connection string that addresses any other project', () => {
    expect(() => assertProjectRefPinned(WRONG)).toThrow(ProductionMigrationRefusal);
    expect(() => assertProjectRefPinned('')).toThrow(ProductionMigrationRefusal);
    expect(() => assertProjectRefPinned('not a url at all')).toThrow(ProductionMigrationRefusal);
  });

  it('never puts the password — or the string — into its refusal message', () => {
    for (const bad of [WRONG, 'not a url at all']) {
      try {
        assertProjectRefPinned(bad);
        throw new Error('should have refused');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).not.toContain('s3cr3tpassw0rd');
        expect(msg).not.toContain(bad);
      }
    }
  });
});

describe('production migration executor — the CLI dry-run transcript is the second single-pending proof', () => {
  const ALL = ['194_phoenix_step_194.sql', '195_phoenix_step_195.sql', TARGET_FILE];

  it('passes when the transcript names exactly the pinned migration', () => {
    const transcript = `Connecting to remote database...\nWould push these migrations:\n • ${TARGET_FILE}\n`;
    expect(assertDryRunNamesOnlyTarget(transcript, { expectedFilename: TARGET_FILE, allLocalFilenames: ALL }))
      .toEqual({ expectedFilename: TARGET_FILE, targetVersion: 196 });
  });

  it('refuses a transcript that names another migration as well', () => {
    const transcript = `Would push these migrations:\n • 195_phoenix_step_195.sql\n • ${TARGET_FILE}\n`;
    let thrown: unknown;
    try {
      assertDryRunNamesOnlyTarget(transcript, { expectedFilename: TARGET_FILE, allLocalFilenames: ALL });
    } catch (e) { thrown = e; }
    expect((thrown as ProductionMigrationRefusal).code).toBe('DRY_RUN_EXTRA_MIGRATION');
  });

  it('refuses a transcript that names the target AND another migration by bare version number', () => {
    const transcript = `Would push these migrations:\n • ${TARGET_FILE}\n • 195\n`;
    let thrown: unknown;
    try {
      assertDryRunNamesOnlyTarget(transcript, { expectedFilename: TARGET_FILE, allLocalFilenames: ALL });
    } catch (e) { thrown = e; }
    expect((thrown as ProductionMigrationRefusal).code).toBe('DRY_RUN_EXTRA_MIGRATION');
  });

  // A transcript reporting ONLY bare version numbers is refused too, but as
  // TARGET_ABSENT: the proof has become unreadable, which is not a pass.
  it('refuses a bare-version-only transcript as an unreadable proof, not as a pass', () => {
    const transcript = `Would push these migrations:\n 195\n 196\n`;
    let thrown: unknown;
    try {
      assertDryRunNamesOnlyTarget(transcript, { expectedFilename: TARGET_FILE, allLocalFilenames: ALL });
    } catch (e) { thrown = e; }
    expect((thrown as ProductionMigrationRefusal).code).toBe('DRY_RUN_TARGET_ABSENT');
  });

  it('refuses a transcript that never names the target — an unreadable proof is not a passed proof', () => {
    for (const transcript of ['', 'Remote database is up to date.\n', 'Would push these migrations:\n']) {
      let thrown: unknown;
      try {
        assertDryRunNamesOnlyTarget(transcript, { expectedFilename: TARGET_FILE, allLocalFilenames: ALL });
      } catch (e) { thrown = e; }
      expect((thrown as ProductionMigrationRefusal).code).toBe('DRY_RUN_TARGET_ABSENT');
    }
  });
});

describe('production migration executor — a migration\'s own apply policy is honoured', () => {
  it('refuses to push a migration whose bytes declare MANUAL APPLY ONLY', () => {
    const manual = localSet(196, { 196: {} }).map((m) =>
      m.version === 196 ? { ...m, manualApplyOnly: true } : m,
    );
    const r = expectRefusal({ ...baseline(), localMigrations: manual }, 'MIGRATION_IS_MANUAL_APPLY_ONLY');
    expect(r.message).toContain('own stated apply policy');
  });

  it('detects every banner wording the repository actually uses', () => {
    for (const banner of [
      '-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.',
      '-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.',
      '-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.',
      '-- MANUAL APPLY ONLY. NEVER `supabase db push`.',
      '-- FORWARD-ONLY · ATOMIC · MANUAL APPLY ONLY',
      '-- manual apply only (lower case still counts)',
    ]) {
      expect(declaresManualApplyOnly(`-- header\n${banner}\nBEGIN;\n`), banner).toBe(true);
    }
    expect(declaresManualApplyOnly('-- 147_phoenix_secure_user_delete_history_guard.sql\nBEGIN;\n')).toBe(false);
    expect(declaresManualApplyOnly(undefined)).toBe(false);
  });

  // Grounds the convention in this repository's actual bytes rather than in a
  // remembered rule: 195 (SQL-Editor route) carries the banner, 147 (the one
  // migration a pinned workflow applies) does not.
  it('matches the convention the repository itself follows', () => {
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const readMig = (name: string) => readFileSync(new URL(name, dir), 'utf8');
    expect(declaresManualApplyOnly(readMig('195_phoenix_auth_helper_profile_schema_qualification.sql'))).toBe(true);
    expect(declaresManualApplyOnly(readMig('147_phoenix_secure_user_delete_history_guard.sql'))).toBe(false);
  });
});

describe('production migration executor — filename parsing', () => {
  it('reads the numeric version only from a well-formed migration filename', () => {
    expect(parseMigrationVersion('196_phoenix_x.sql')).toBe(196);
    expect(parseMigrationVersion('001_phoenix_core_schema.sql')).toBe(1);
    expect(parseMigrationVersion('196_phoenix_x.SQL')).toBeNull();
    expect(parseMigrationVersion('1960_phoenix_x.sql')).toBeNull();
    expect(parseMigrationVersion('196.sql')).toBeNull();
    expect(parseMigrationVersion(undefined)).toBeNull();
  });
});
