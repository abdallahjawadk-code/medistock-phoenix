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

/**
 * A reconciled remote history at `ceiling`, as production-migration-history.mjs
 * would return it. The contract no longer sees raw remote versions at all:
 * Production's two namespaces (172 three-digit rows then 14-digit Supabase
 * timestamps) are reconciled first, and the shape/ordering/duplicate/gap
 * refusals that used to live here are proven in
 * production-migration-history.test.ts instead.
 */
const canon = (ceiling: number, localCeiling = 196) => ({
  canonicalCeiling: ceiling,
  appliedCanonical: Array.from({ length: ceiling }, (_, i) => i + 1),
  pendingCanonical: Array.from({ length: Math.max(0, localCeiling - ceiling) }, (_, i) => ceiling + 1 + i),
});

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
  remoteCanonical: canon(195),
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

// ===========================================================================
// REGRESSION — real Production incident, run 33822028630, 2026-09-04.
//
// Migrations 203-208 were reviewed and merged to master together in one PR
// (181). Production had applied none of them. Dispatching the executor
// pinned to target=203 (current=202, next=203) FAILED before any database
// connection: the workflow's cheap YAML pre-check computed the checkout's
// migration ceiling as the highest FILE PRESENT (208) and refused because
// 208 !== 203. The SAME conflation existed one layer down, in this contract:
// `localCeiling` (== 208, the highest file in the whole catalogue) was
// required to equal `next` (203), and even past that, `pendingVersions`
// (local-minus-remote over the WHOLE catalogue) was required to be exactly
// [203] — but with 204-208 also unapplied, it is [203,204,205,206,207,208].
// Both checks reject a state that must be legal: the REPOSITORY CATALOGUE
// may legitimately hold reviewed future migrations; only the AUTHORIZED
// EXECUTION SET (the shadow workspace: applied aliases + this one target)
// must be bounded to exactly one pending migration, and that is already
// enforced independently by buildShadowMigrationWorkspace() and by the two
// CLI dry-run proofs — never by this function reasoning about the whole
// catalogue.
// ===========================================================================
describe('production migration executor — REGRESSION: prepared future migrations in the catalogue (run 33822028630)', () => {
  it('APPLIES target 203 when the catalogue reaches 208 and Production is at 202 (the real incident shape)', () => {
    const out = decideProductionMigrationApply({
      ...baseline(),
      expectedCurrentCeiling: '202',
      expectedNextCeiling: '203',
      migrationFilename: '203_phoenix_material_dispensing_suspension.sql',
      migrationSha256: 'bc46c2f9e984d8a5e8f40548878ff15ad9ae38410ef180aa909c0453d4cb6de8',
      localMigrations: localSet(208, { 203: { filename: '203_phoenix_material_dispensing_suspension.sql', sha256: 'bc46c2f9e984d8a5e8f40548878ff15ad9ae38410ef180aa909c0453d4cb6de8' } }),
      remoteCanonical: canon(202, 208),
    } as never);
    expect(out.decision).toBe('APPLY');
    expect(out.targetVersion).toBe(203);
    expect(out.localCeiling).toBe(208);
    // 204-208 are legitimately unapplied and present, so they appear in the
    // informational pending list -- but per the shadow-workspace model that
    // list no longer gates the decision. What matters is proven elsewhere.
    expect(out.pendingVersions).toEqual([203, 204, 205, 206, 207, 208]);
  });

  it('remains ALREADY_APPLIED (resume-safe) for target 203 once Production reaches 203, with 204-208 still only prepared', () => {
    const out = decideProductionMigrationApply({
      ...baseline(),
      expectedCurrentCeiling: '202',
      expectedNextCeiling: '203',
      migrationFilename: '203_phoenix_material_dispensing_suspension.sql',
      migrationSha256: 'bc46c2f9e984d8a5e8f40548878ff15ad9ae38410ef180aa909c0453d4cb6de8',
      localMigrations: localSet(208, { 203: { filename: '203_phoenix_material_dispensing_suspension.sql', sha256: 'bc46c2f9e984d8a5e8f40548878ff15ad9ae38410ef180aa909c0453d4cb6de8' } }),
      remoteCanonical: canon(203, 208),
    } as never);
    expect(out.decision).toBe('ALREADY_APPLIED');
    expect(out.pendingVersions).toEqual([204, 205, 206, 207, 208]);
  });

  it.each([203, 204, 205, 206, 207, 208])(
    'sequential validity: target %i applies when Production is exactly one behind it and the catalogue reaches 208',
    (target) => {
      const out = decideProductionMigrationApply({
        ...baseline(),
        expectedCurrentCeiling: String(target - 1),
        expectedNextCeiling: String(target),
        migrationFilename: `${target}_phoenix_step_${target}.sql`,
        migrationSha256: String(target).padStart(64, '0'),
        localMigrations: localSet(208),
        remoteCanonical: canon(target - 1, 208),
      } as never);
      expect(out.decision).toBe('APPLY');
      expect(out.targetVersion).toBe(target);
    },
  );
});

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
    const out = decideProductionMigrationApply({ ...baseline(), remoteCanonical: canon(196) } as never);
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

  // CORRECTED 2026-09-04 (run 33822028630): a checkout carrying 197 (or
  // further) alongside the pinned target 196 is the ORDINARY shape once
  // several migrations are reviewed together, and must APPLY -- see the
  // dedicated REGRESSION describe block above, which proves this exhaustively
  // for the real incident numbers. These two cases are kept, not deleted,
  // specifically because they used to assert the wrong (refusing) behaviour
  // and a reader diffing history should see the correction in place, not a
  // silently vanished case.
  it('a checkout carrying 197 as well as 196 still APPLIES 196 — the catalogue may run ahead of the target', () => {
    const out = decideProductionMigrationApply(
      { ...baseline(), localMigrations: localSet(197), remoteCanonical: canon(195, 197) } as never,
    );
    expect(out.decision).toBe('APPLY');
    expect(out.targetVersion).toBe(196);
    expect(out.localCeiling).toBe(197);
  });

  it('a locally-prepared future migration does not block the pinned target — same correction, stated as the operator would hit it', () => {
    const out = decideProductionMigrationApply({ ...baseline(), localMigrations: localSet(198) } as never);
    expect(out.decision).toBe('APPLY');
    expect(out.localCeiling).toBe(198);
  });

  it('the checkout genuinely not containing the pinned version still refuses — TARGET_MIGRATION_MISSING, not a ceiling mismatch', () => {
    // localSet(195) has no version-196 file at all; distinct from the two
    // cases above, where 196 exists and merely isn't the catalogue's highest.
    const r = expectRefusal({ ...baseline(), localMigrations: localSet(195) }, 'TARGET_MIGRATION_MISSING');
    expect(r.message).toContain('found 0');
  });

  it('unexpected Production future migration — this checkout is behind Production', () => {
    const r = expectRefusal({ ...baseline(), remoteCanonical: canon(197) }, 'REMOTE_FUTURE_MIGRATION');
    expect(r.message).toContain('197');
  });

  it('wrong current ceiling — Production is not where the operator claimed it was', () => {
    const r = expectRefusal({ ...baseline(), remoteCanonical: canon(194) }, 'UNEXPLAINED_STATE');
    expect(r.message).toContain('194');
    expect(r.message).toContain('without applying, retrying, or repairing');
  });

  it('migration number gap — locally', () => {
    const gapped = localSet(196).filter((m) => m.version !== 100);
    expectRefusal({ ...baseline(), localMigrations: gapped }, 'LOCAL_HISTORY_GAP');
  });

  // A gap or duplicate in Production's raw history is now refused upstream by
  // reconcileMigrationHistory (REMOTE_NUMERIC_GAP / REMOTE_DUPLICATE_VERSION,
  // covered in production-migration-history.test.ts) — the contract can no
  // longer be reached with an unsound history. What it still guards is an
  // internally inconsistent reconciliation result.
  it('an internally inconsistent reconciled history', () => {
    expectRefusal(
      { ...baseline(), remoteCanonical: { canonicalCeiling: 195, appliedCanonical: [1, 2, 3], pendingCanonical: [196] } },
      'REMOTE_HISTORY_NOT_INCREASING',
    );
  });

  it('empty histories', () => {
    expectRefusal({ ...baseline(), localMigrations: [] }, 'LOCAL_HISTORY_EMPTY');
    expectRefusal({ ...baseline(), remoteCanonical: undefined }, 'REMOTE_HISTORY_EMPTY');
  });

  // REMOVED 2026-09-04 (run 33822028630): PENDING_SET_NOT_SINGLE used to
  // require the CATALOGUE's pending set (local minus remote, over every file
  // in supabase/migrations) to be exactly [next]. Once the catalogue
  // legitimately holds prepared future migrations, that set is routinely
  // [next, next+1, ...] and the check refused a state that must be legal --
  // it was reachable, and it was the second half of the real incident. The
  // single-pending guarantee is unaffected: it is proven on the AUTHORIZED
  // EXECUTION SET (the shadow workspace) instead, by construction and by the
  // two independent CLI dry-run proofs, neither of which reasons about the
  // whole catalogue. This test now proves the removal is permanent, not that
  // the code still exists.
  it('does not gate the decision on the catalogue-wide pending set — a wide-reaching catalogue still applies cleanly', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../production-migration-contract.mjs', import.meta.url), 'utf8'),
    );
    expect(src).not.toContain('PENDING_SET_NOT_SINGLE');
    const out = decideProductionMigrationApply(
      { ...baseline(), localMigrations: localSet(199), remoteCanonical: canon(195, 199) } as never,
    );
    expect(out.decision).toBe('APPLY');
    expect(out.pendingVersions).toEqual([196, 197, 198, 199]);
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

describe('production migration executor — migrations 203-208 are untouched by this repair', () => {
  const dir = new URL('../../../supabase/migrations/', import.meta.url);
  const NAMES = [
    '203_phoenix_material_dispensing_suspension.sql',
    '204_phoenix_dispensing_suspension_enforcement_dispense.sql',
    '205_phoenix_dispensing_suspension_enforcement_fefo.sql',
    '206_phoenix_dispensing_suspension_enforcement_suggestions.sql',
    '207_phoenix_dispensing_suspension_enforcement_warehouse_send.sql',
    '208_phoenix_dispensing_suspension_enforcement_replenishment_and_drafts.sql',
  ];

  it('all six files this repair reasons about still exist, with well-formed sequential filenames', () => {
    for (const [i, name] of NAMES.entries()) {
      expect(parseMigrationVersion(name), name).toBe(203 + i);
      expect(() => readFileSync(new URL(name, dir))).not.toThrow();
    }
  });

  // 203's identity is pinned from independently sealed campaign evidence
  // (artifact 727 / the run-33822028630 dispatch, both computed from the
  // canonical Git blob), not from this checkout — a real external pin, so
  // this genuinely catches tampering rather than checking a value against
  // itself.
  it('migration 203 is byte-identical to its sealed identity', async () => {
    const { createHash } = await import('node:crypto');
    const bytes = readFileSync(new URL(NAMES[0], dir));
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('bc46c2f9e984d8a5e8f40548878ff15ad9ae38410ef180aa909c0453d4cb6de8');
    expect(bytes.length).toBe(27173);
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
