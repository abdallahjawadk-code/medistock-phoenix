/**
 * Phase P - the hosted-adapter's guards (pure) and its METHOD on a disposable PostgreSQL (dynamic). No hosted project is contacted; the hosted
 * executor cannot run SQL. TEST-ONLY authorization/attestation values appear ONLY against a disposable target and are never acceptance evidence.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { rigAvailable, buildRig, MIGRATIONS_DIR, freshRigDb } from '../../../tools/pg-rig/rig.mjs';
import { derive023, fingerprint, VERIFY_BASELINE, sha256, buildBaseline } from '../staging-baseline/staging-baseline.mjs';
import { R1B_PINS, HOSTED_CONFIRMATION_S3A, hostedConfirmationS3B, hostedConfirmationS3P, PROVISION_KEYS, PROVISION_ITEMS, CANDIDATE_PINS, HOSTED_CONFIRMATION_S2, bindCandidates, BOOTSTRAP_HASH, bindSources, cliMain, HOSTED_CONFIRMATION, PINNED_AUX, bindAux, verifyDisposableIdentity, AdapterStop, HostedExecutor, PgExecutor, preflight, parseConnectionDescriptor, verifyConnectionIdentity, assertSimilarityAvailable, readLedger, analyzeLedger, PINNED, HOSTED_APPLY_ENABLED, assertTarget, planBaseline, runBaseline, rollbackReview, captureAclSnapshot, LEDGER_SQL } from '../staging-baseline/hosted-adapter/hosted-adapter.mjs';

const FREEZE = JSON.parse(readFileSync(join(__dirname, '..', 'staging-baseline', 'M001-M221-freeze.json'), 'utf8'));
const has221 = () => readdirSync(MIGRATIONS_DIR).some((f) => f.startsWith('221_'));
const stopCode = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'NO-STOP'; };
const AUTH = { phase: 'S1', scope: 'baseline-M001-M221', projectRef: 'disposable-local', authorizedBy: 'TEST-ONLY (synthetic, disposable rig)', authorizedOn: '2026-10-19' };
const EVID = 'e'.repeat(64);
const P5 = { ownerRef: 'TEST-ONLY synthetic attestation (not an Owner attestation)', attestedOn: '2026-10-19', projectRef: 'disposable-local', evidenceSha256: EVID };
const BOOT_ID = '00000000-0000-0000-0000-00000000b007';
const BOOT = { phase: 'S1-BOOTSTRAP', projectRef: 'disposable-local', authUserId: BOOT_ID, email: 'owner-test@rig.local', ownerRef: 'TEST-ONLY synthetic bootstrap (not an Owner attestation)', attestedOn: '2026-10-19' };
const P4_FUNCS = ['public.phoenix_upsert_availability(uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text)', 'public.phoenix_apply_availability_movement(uuid, text, integer, text, text)'];
// a mid-chain, gate-clean stop used by the recovery tests: authenticated EXECUTE is withdrawn right before M085 => STOP-P4 with M084 as the last APPLIED step
const P4_STOP = { testHook: async (f: string, e: any) => { if (f.startsWith('085_')) await e.query(`REVOKE EXECUTE ON FUNCTION ${P4_FUNCS[1]} FROM authenticated`); } };
const CATS = ['proc', 'rel', 'col', 'policy', 'trigger', 'constraint', 'index', 'permission_keys', 'role_defaults', 'roles'];

describe('hosted-adapter - non-executable by default (pure)', () => {
  it('hosted apply is disabled in Phase P and the hosted executor has no connection', async () => {
    expect(HOSTED_APPLY_ENABLED).toBe(false);
    expect(await stopCode(new HostedExecutor(PINNED.stagingRef).query('select 1'))).toBe('STOP-PHASE-P');
    const dry = await runBaseline(new HostedExecutor(PINNED.stagingRef), { freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221 });
    expect(dry.mode).toBe('dry-run'); expect(dry.executed).toBe(0);
    expect(await stopCode(runBaseline(new HostedExecutor(PINNED.stagingRef), { freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, mode: 'apply',
      authorization: { phase: 'S1', scope: 'baseline-M001-M221', projectRef: PINNED.stagingRef, authorizedBy: 'Owner Name', authorizedOn: '2026-10-19' } }))).toBe('STOP-IDENTITY');
  });
  it('the target is pinned: Production is refused in every spelling, any other ref is refused, a missing ref is refused', () => {
    expect(() => assertTarget({ kind: 'hosted', ref: PINNED.productionRef })).toThrow(/PRODUCTION/);
    expect(() => assertTarget({ kind: 'hosted', ref: PINNED.stagingRef, host: `db.${PINNED.productionRef}.supabase.co` })).toThrow(/PRODUCTION/);
    expect(() => assertTarget({ kind: 'hosted', ref: 'someotherprojectref0000' })).toThrow(/pinned Staging/);
    expect(() => assertTarget({ kind: 'hosted', ref: '' })).toThrow(/missing/);
    expect(() => assertTarget({ kind: 'weird', ref: PINNED.stagingRef })).toThrow(/unknown target kind/);
    expect(assertTarget({ kind: 'hosted', ref: PINNED.stagingRef }).ok).toBe(true);
  });
  it('the dry-run plan is complete and honest: 221 files, M004 not applied, M023 derived, 182b a separate overlay, gates named, rollback reviewed', () => {
    if (!has221()) return;
    const plan = planBaseline({ freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221 });
    const files = plan.filter((s: any) => s.file && !s.file.includes('overlay') && !s.file.includes('bootstrap') && s.file !== 'platform default-ACL alignment');
    expect(files.length).toBe(221);
    expect(plan.find((s: any) => s.file?.startsWith('004_')).action).toMatch(/NOT_APPLIED/);
    expect(plan.find((s: any) => s.file?.startsWith('023_')).derived).toBe(true);
    expect(plan.filter((s: any) => s.file === '182b overlay').length).toBe(1);
    expect(plan.some((s: any) => /STOP-BOOTSTRAP/.test(s.gate ?? ''))).toBe(true);
    expect(plan.some((s: any) => /STOP-P5/.test(s.gate ?? ''))).toBe(true);
    for (const l of rollbackReview()) expect(l.length).toBeGreaterThan(40);
    expect(rollbackReview().join(' ')).toMatch(/never issues DROP/);
  });
  it('STOP-SOURCE: one altered frozen file is refused in the PLAN, before anything can run', () => {
    if (!has221()) return;
    const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('120_'))!;
    expect(() => planBaseline({ freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221, tamper: { [name]: (b: Buffer) => Buffer.concat([b, Buffer.from('\n-- x')]) } })).toThrow(/STOP-SOURCE/);
  });
  it('the ledger is independent: it never writes supabase_migrations.schema_migrations', () => {
    const src = readFileSync(join(__dirname, '..', 'staging-baseline', 'hosted-adapter', 'hosted-adapter.mjs'), 'utf8');
    expect(LEDGER_SQL).not.toMatch(/schema_migrations/);
    expect(src.replace(/\/\/.*$/gm, '')).not.toMatch(/INSERT INTO\s+supabase_migrations|UPDATE\s+supabase_migrations|CREATE TABLE[^;]*schema_migrations/i);
    expect(src).toMatch(/phoenix_staging_ledger/);
  });
});

const run = rigAvailable() && has221() ? describe : describe.skip;
run('hosted-adapter method on a DISPOSABLE PostgreSQL (dynamic)', { timeout: 900_000 }, () => {
  async function fresh() {
    const c = await freshRigDb({});                                     // TEST harness only: an empty disposable database + the Supabase stand-in bootstrap
    await c.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [BOOT_ID, BOOT.email]);   // what the OWNER does before S1: create the Auth user (before M001, so no profile trigger exists yet)
    return { c, exec: new PgExecutor(c, { kind: 'disposable-test', ref: 'disposable-local' }) };
  }
  const base = { freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221, mode: 'apply' as const, authorization: AUTH, evidenceSha256: EVID, bootstrap: BOOT };

  it('apply with skip004 + 182b + M023 derivation + REAL P4 + (test-only) P5 reproduces the PG-rig reference state; M140-M145 kept; ledger independent; PG major verified', async () => {
    // reference 1: the PG-rig canonical build (LF checkout bytes). reference 2: the tested builder with the FROZEN bytes (the same bytes the adapter applies).
    const ref = await buildRig({ upTo: 221 }); const fpRig = await ref.asAdmin((c: any) => fingerprint(c)); await ref.end();
    const bb = await buildBaseline({ freeze: FREEZE, skip004: true, attestation: { ownerRef: 'TEST-ONLY synthetic attestation on a disposable rig (not an Owner attestation)', evidenceSha256: 'f'.repeat(64) } });
    const fpRef = await fingerprint(bb.client); await bb.client.end();
    const { c, exec } = await fresh();
    const pre = await preflight(exec);
    expect(pre.public_tables).toBe(0); expect(pre.recorded_migrations).toBe(0); expect(pre.extensions_available).toContain('pg_trgm');
    const out = await runBaseline(exec, { ...base, p5: P5 });
    expect(out.executed).toBe(220);                                      // 221 files minus the skipped M004
    const ledger = (await c.query(`SELECT step, status, action, derivation, attestation_ref, target_ref FROM phoenix_staging_ledger.baseline_steps ORDER BY seq`)).rows;
    expect(ledger.length).toBe(220 * 2 + 1 + 2 + 2 + 2);                     // STARTED+APPLIED per applied step (220) + M004 SKIPPED + overlay + bootstrap profile STARTED/APPLIED
    expect(ledger.filter((r: any) => r.status === 'STARTED').length).toBe(223);   // 220 files + overlay + bootstrap profile + default-ACL alignment
    expect(ledger.find((r: any) => r.step.startsWith('004_')).action).toMatch(/NOT_APPLIED/);
    expect(ledger.find((r: any) => r.step.startsWith('023_') && r.status === 'APPLIED').derivation).toBe('023-verify-read');
    expect(ledger.find((r: any) => r.step === '182b overlay' && r.status === 'APPLIED').action).toMatch(/overlay/);
    expect(ledger.find((r: any) => r.step.startsWith('085_') && r.status === 'APPLIED').attestation_ref).toMatch(/^TEST-ONLY/);
    expect(new Set(ledger.map((r: any) => r.target_ref))).toEqual(new Set(['disposable-local']));
    expect((await c.query(`SELECT to_regclass('supabase_migrations.schema_migrations') AS r`)).rows[0].r).toBeNull();
    const v = (await c.query(readFileSync(VERIFY_BASELINE, 'utf8'))).rows;
    expect(v.filter((r: any) => !r.ok).map((r: any) => r.check)).toEqual([]);   // incl. demo-protection mechanisms M140-M145 present
    expect(((await runBaseline(exec, { ...base, mode: 'recovery-plan' })) as any).analysis.classification).toBe('COMPLETE');   // strict grammar accepts the genuine full ledger
    await c.query('DROP SCHEMA phoenix_staging_ledger CASCADE');
    const fp = await fingerprint(c);
    expect(CATS.filter((k) => fp[k] !== fpRef[k])).toEqual([]);          // 10 catalog categories identical to the frozen-bytes reference
    expect(CATS.filter((k) => fp[k] !== fpRig[k])).toEqual(['proc']);    // vs the LF-checkout rig: ONLY function text of the 4 CRLF-frozen files differs (the documented line-ending effect)
    const acl = await captureAclSnapshot(exec); expect(acl.length).toBeGreaterThan(500);
    await c.end();
  });

  it('STOP-AUTH: no authorization / an authorization for another target / a non-TEST authorization on a disposable target', async () => {
    const { c, exec } = await fresh();
    expect(await stopCode(runBaseline(exec, { ...base, authorization: undefined }))).toBe('STOP-AUTH');
    expect(await stopCode(runBaseline(exec, { ...base, authorization: { ...AUTH, projectRef: PINNED.stagingRef } }))).toBe('STOP-AUTH');
    expect(await stopCode(runBaseline(exec, { ...base, authorization: { ...AUTH, authorizedBy: 'A Real Owner' } }))).toBe('STOP-AUTH');
    expect((await c.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`)).rows[0].n).toBe(0);   // nothing ran
    await c.end();
  });

  it('STOP-TARGET: a wrong PostgreSQL major is refused before any statement', async () => {
    const { c, exec } = await fresh();
    expect(await stopCode(runBaseline(exec, { ...base, p5: P5, expectedMajor: 18 }))).toBe('STOP-TARGET');
    await c.end();
  });

  const nothingWritten = async (c: any) => {
    expect((await c.query(`SELECT to_regnamespace('phoenix_staging_ledger') AS l`)).rows[0].l).toBeNull();
    expect((await c.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`)).rows[0].n).toBe(0);
    expect((await c.query(`SELECT count(*)::int n FROM auth.users`)).rows[0].n).toBe(1);          // only the Owner-created one: the adapter creates no Auth user
  };

  it('STOP-BOOTSTRAP is refused BEFORE the first write for every missing/invalid Owner bootstrap input (no ledger, no table, no Auth user created)', async () => {
    const cases: Record<string, any> = {
      'missing': undefined,
      'wrong phase': { ...BOOT, phase: 'S1' },
      'other project': { ...BOOT, projectRef: PINNED.stagingRef },
      'not a uuid': { ...BOOT, authUserId: 'not-a-uuid' },
      'unknown Auth user': { ...BOOT, authUserId: '00000000-0000-0000-0000-00000000dead' },
      'email differs': { ...BOOT, email: 'someone-else@rig.local' },
      'no email': { ...BOOT, email: '' },
      'unnamed': { ...BOOT, ownerRef: '' },
      'undated': { ...BOOT, attestedOn: '' },
      'non-TEST attestation on a disposable target': { ...BOOT, ownerRef: 'A Real Owner' },
    };
    for (const [name, bootstrap] of Object.entries(cases)) {
      const { c, exec } = await fresh();
      expect(await stopCode(runBaseline(exec, { ...base, p5: P5, bootstrap })), name).toBe('STOP-BOOTSTRAP');
      await nothingWritten(c);
      await c.end();
    }
  });

  it('the bootstrap point: after M001 and before M062 the adapter links the Owner-created Auth user to a profile (exactly one, super_admin/active), ledgered, creating no Auth user', async () => {
    const { c, exec } = await fresh();
    const hook = async (f: string, e: any) => {
      if (f.startsWith('002_')) {
        const prof = (await e.query(`SELECT id, role, status FROM public.profiles`)).rows;
        expect(prof).toEqual([{ id: BOOT_ID, role: 'super_admin', status: 'active' }]);        // already linked right after M001, long before M062
      }
    };
    await runBaseline(exec, { ...base, p5: P5, upTo: 70, testHook: hook });          // crosses M062: its own super_admin check passes only because of the bootstrap step
    const led = (await c.query(`SELECT step, status, attestation_ref FROM phoenix_staging_ledger.baseline_steps WHERE step = 'bootstrap profile' ORDER BY seq`)).rows;
    expect(led.map((r: any) => r.status)).toEqual(['STARTED', 'APPLIED']);
    expect(led[1].attestation_ref).toMatch(/^TEST-ONLY.*#auth:00000000$/);
    expect((await c.query(`SELECT count(*)::int n FROM auth.users`)).rows[0].n).toBe(1);
    await c.end();
  });

  it('pg_trgm already installed outside public is refused BEFORE the first write (STOP-EXTENSION), as is a bootstrap against a target that already has public.profiles', async () => {
    const { c, exec } = await fresh();
    await c.query('CREATE SCHEMA IF NOT EXISTS extensions'); await c.query('CREATE EXTENSION pg_trgm WITH SCHEMA extensions');
    expect(await stopCode(runBaseline(exec, { ...base, p5: P5 }))).toBe('STOP-EXTENSION');
    await c.query('DROP EXTENSION pg_trgm');
    await nothingWritten(c);
    await c.end();
  });

  it('STOP-P5 (hard stop, before the first write): no attestation, an unbound/other-evidence one, an undated one, an unnamed one, or one for another target - M085 is never applied', async () => {
    for (const p5 of [undefined, { ...P5, evidenceSha256: 'f'.repeat(64) }, { ...P5, attestedOn: '' }, { ...P5, ownerRef: '' }, { ...P5, projectRef: PINNED.stagingRef }]) {
      const { c, exec } = await fresh();
      expect(await stopCode(runBaseline(exec, { ...base, p5: p5 as any }))).toBe('STOP-P5');
      await nothingWritten(c);                                           // refused BEFORE the first write: not even M001 ran
      await c.end();
    }
  });

  it('STOP-P4: when an authenticated EXECUTE has been withdrawn before M085 the adapter stops at P4 (even with a valid-looking TEST-ONLY attestation) and M085 is not applied', async () => {
    for (const fn of ['public.phoenix_upsert_availability(uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text)', 'public.phoenix_apply_availability_movement(uuid, text, integer, text, text)']) {
      const { c, exec } = await fresh();
      const hook = async (f: string, e: any) => { if (f.startsWith('085_')) await e.query(`REVOKE EXECUTE ON FUNCTION ${fn} FROM authenticated`); };
      expect(await stopCode(runBaseline(exec, { ...base, p5: P5, testHook: hook }))).toBe('STOP-P4');
      const last = (await c.query(`SELECT step FROM phoenix_staging_ledger.baseline_steps ORDER BY seq DESC LIMIT 1`)).rows[0].step;
      expect(last.startsWith('084_')).toBe(true);
      await c.end();
    }
  });

  it('the TEST-ONLY attestation is refused on a hosted-kind target (even when apply were enabled): the hosted gates stop first, STOP-P5 logic never reached', async () => {
    expect(await stopCode(runBaseline(new HostedExecutor(PINNED.stagingRef), { ...base, authorization: { ...AUTH, projectRef: PINNED.stagingRef, authorizedBy: 'Owner' }, p5: { ...P5, projectRef: PINNED.stagingRef } }))).toBe('STOP-IDENTITY');
  });

  // ---------- P-HARDEN-01B (F2): NO resume. A stopped run is classified read-only; every non-empty state is an owner decision ----------
  const tailOf = async (c: any) => (await c.query(`SELECT seq, step, status FROM phoenix_staging_ledger.baseline_steps ORDER BY seq DESC LIMIT 1`)).rows[0];
  const step120 = () => readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('120_'))!;
  const plan = async (exec: any) => ((await runBaseline(exec, { ...base, mode: 'recovery-plan' })) as any).analysis;
  const REC = { phase: 'S1-RECOVERY', targetRef: 'disposable-local', afterStep: 'x', ledgerSeq: 1, authorizedBy: 'TEST-ONLY (synthetic, disposable rig)', authorizedOn: '2026-10-19' };

  it('a run broken inside a file leaves a FAILED tail; apply again is STOP-PARTIAL; recovery-plan says FAILED (owner decision); resume is refused even with a full authorization', async () => {
    const { c, exec } = await fresh();
    expect(await stopCode(runBaseline(exec, { ...base, p5: P5, testBreakStep: step120() }))).toBe('STOP-APPLY');
    const tail = await tailOf(c); expect(tail.status).toBe('FAILED'); expect(tail.step).toBe(step120());
    expect(await stopCode(runBaseline(exec, { ...base, p5: P5 }))).toBe('STOP-PARTIAL');
    const an = await plan(exec); expect(an.classification).toBe('FAILED'); expect(an.allowed).toMatch(/NO resume/);
    expect(await stopCode(runBaseline(exec, { ...base, mode: 'resume', p5: P5, recovery: { ...REC, afterStep: tail.step, ledgerSeq: tail.seq } } as any))).toBe('STOP-RECOVERY');
    await c.end();
  });

  it('an interrupted run (tail STARTED, no outcome recorded) is AMBIGUOUS; nothing continues it', async () => {
    const { c, exec } = await fresh();
    await expect(runBaseline(exec, { ...base, p5: P5, testBreakStep: step120() })).rejects.toBeTruthy();
    await c.query(`DELETE FROM phoenix_staging_ledger.baseline_steps WHERE status = 'FAILED'`);      // simulates a crash between STARTED and the outcome event
    expect((await tailOf(c)).status).toBe('STARTED');
    expect((await plan(exec)).classification).toBe('AMBIGUOUS');
    expect(await stopCode(runBaseline(exec, { ...base, p5: P5 }))).toBe('STOP-PARTIAL');
    await c.end();
  });

  it('a stop at a gate (STOP-P4 before M085) is CLEAN-BOUNDARY but informational only: resume is refused, apply is STOP-PARTIAL, the ledger does not change', async () => {
    const { c, exec } = await fresh();
    expect(await stopCode(runBaseline(exec, { ...base, p5: P5, ...P4_STOP }))).toBe('STOP-P4');
    const before = (await c.query(`SELECT count(*)::int n FROM phoenix_staging_ledger.baseline_steps`)).rows[0].n;
    const an = await plan(exec); expect(an.classification).toBe('CLEAN-BOUNDARY'); expect(an.next.startsWith('085_')).toBe(true); expect(an.allowed).toMatch(/NO resume/);
    const tail = await tailOf(c);
    expect(await stopCode(runBaseline(exec, { ...base, mode: 'resume', p5: P5, recovery: { ...REC, afterStep: tail.step, ledgerSeq: tail.seq } } as any))).toBe('STOP-RECOVERY');
    expect(await stopCode(runBaseline(exec, { ...base, p5: P5 }))).toBe('STOP-PARTIAL');
    expect((await c.query(`SELECT count(*)::int n FROM phoenix_staging_ledger.baseline_steps`)).rows[0].n).toBe(before);
    await c.end();
  });

  it('strict ledger grammar: every tampering of a stopped ledger is INTEGRITY-FAILURE (hash, applied hash, missing STARTED, duplicate, other target, event after FAILED, SKIPPED on a non-M004 step, step beyond the plan, swapped steps, wrong seq order)', async () => {
    const { c, exec } = await fresh();
    expect(await stopCode(runBaseline(exec, { ...base, p5: P5, ...P4_STOP }))).toBe('STOP-P4');
    expect((await plan(exec)).classification).toBe('CLEAN-BOUNDARY');
    const L = 'phoenix_staging_ledger.baseline_steps';
    const mutations: Record<string, string[]> = {
      'original hash altered': [`UPDATE ${L} SET original_sha256 = repeat('0',64) WHERE step LIKE '010_%' AND status = 'APPLIED'`],
      'applied hash altered': [`UPDATE ${L} SET applied_sha256 = repeat('1',64) WHERE step LIKE '010_%' AND status = 'APPLIED'`],
      'STARTED missing': [`DELETE FROM ${L} WHERE step LIKE '010_%' AND status = 'STARTED'`],
      'duplicate APPLIED': [`INSERT INTO ${L} (step,status,original_sha256,applied_sha256,target_ref) SELECT step,status,original_sha256,applied_sha256,target_ref FROM ${L} WHERE step LIKE '010_%' AND status = 'APPLIED'`],
      'one row for another target': [`UPDATE ${L} SET target_ref = 'someone-else' WHERE step LIKE '010_%' AND status = 'APPLIED'`],
      'event after FAILED': [`INSERT INTO ${L} (step,status,target_ref) VALUES ('999_x.sql','FAILED','disposable-local')`, `INSERT INTO ${L} (step,status,target_ref) VALUES ('085_x.sql','STARTED','disposable-local')`],
      'SKIPPED on a normal step': [`UPDATE ${L} SET status = 'SKIPPED' WHERE step LIKE '010_%' AND status = 'APPLIED'`],
      'step beyond the plan': [`INSERT INTO ${L} (step,status,target_ref) VALUES ('999_beyond.sql','STARTED','disposable-local')`, `INSERT INTO ${L} (step,status,target_ref) VALUES ('999_beyond.sql','APPLIED','disposable-local')`],
      'swapped step names': [`UPDATE ${L} SET step = CASE WHEN step LIKE '010_%' THEN (SELECT min(step) FROM ${L} WHERE step LIKE '011_%') ELSE (SELECT min(step) FROM ${L} WHERE step LIKE '010_%') END WHERE step LIKE '010_%' OR step LIKE '011_%'`],
      'unknown status': [`ALTER TABLE ${L} DROP CONSTRAINT baseline_steps_status_check`, `UPDATE ${L} SET status = 'DONE' WHERE step LIKE '010_%' AND status = 'APPLIED'`],
      'seq order broken': [`WITH d AS (DELETE FROM ${L} WHERE step LIKE '010_%' AND status = 'STARTED' RETURNING step,status,target_ref)
         INSERT INTO ${L} (seq,step,status,target_ref) OVERRIDING SYSTEM VALUE SELECT 100000,step,status,target_ref FROM d`],
    };
    for (const [name, sqls] of Object.entries(mutations)) {
      await c.query('BEGIN');
      try { for (const q of sqls) await c.query(q); const an = await plan(exec); expect(an.classification, name).toBe('INTEGRITY-FAILURE'); }
      finally { await c.query('ROLLBACK'); }
    }
    expect((await plan(exec)).classification).toBe('CLEAN-BOUNDARY');      // all rolled back: the genuine ledger is still valid
    await c.end();
  });

  // ---------- A-ACL-1 (platform default-ACL alignment) ----------
  const SUPA_DEFAULTS = `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role`;
  const defaultAcl = async (c: any) => (await c.query(`SELECT d.defaclobjtype::text t, r.rolname g FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) a JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname='public' AND d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='postgres') AND a.grantee<>d.defaclrole ORDER BY 1,2`)).rows.map((x: any) => `${x.t}:${x.g}`);

  it('A-ACL-1: on a Supabase-like project the step is ledgered BEFORE M001, touches only role postgres/schema public defaults, leaves authenticated+service_role table defaults, and M045 then passes', async () => {
    const { c, exec } = await fresh();
    await c.query(SUPA_DEFAULTS);
    expect(await defaultAcl(c)).toContain('f:anon');
    await runBaseline(exec, { ...base, p5: P5, upTo: 46 });
    const led = (await c.query(`SELECT step, status FROM phoenix_staging_ledger.baseline_steps ORDER BY seq LIMIT 4`)).rows.map((r: any) => `${r.step.slice(0, 12)}/${r.status}`);
    expect(led).toEqual(['platform def/STARTED', 'platform def/APPLIED', '001_phoenix_/STARTED', '001_phoenix_/APPLIED']);
    const acl = await defaultAcl(c);
    expect(acl.filter((x: string) => x.endsWith(':anon'))).toEqual([]);                                  // no anon default of any kind
    expect(acl).not.toContain('f:authenticated');                                                          // no authenticated default on functions
    expect(acl).toEqual(expect.arrayContaining(['r:authenticated', 'r:service_role', 'S:authenticated', 'S:service_role', 'f:service_role']));   // untouched
    expect((await c.query(`SELECT has_function_privilege('anon','public.phoenix_update_my_whatsapp_phone(text)','EXECUTE') a, has_function_privilege('authenticated','public.phoenix_update_my_whatsapp_phone(text)','EXECUTE') u`)).rows[0]).toEqual({ a: false, u: true });
    await c.end();
  });

  it('A-ACL-1 is refused BEFORE the first write when the default ACL carries PUBLIC or an unknown grantee; nothing is written', async () => {
    const { c, exec } = await fresh();
    await c.query(`CREATE ROLE s1_acl_probe NOLOGIN`).catch(() => undefined);
    await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO s1_acl_probe`);
    expect(await stopCode(runBaseline(exec, { ...base, p5: P5 }))).toBe('STOP-TARGET');
    await nothingWritten(c);
    await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM s1_acl_probe`);
    await c.query(`DROP ROLE s1_acl_probe`);
    await c.end();
  });

  it('a file that fails inside its own transaction leaves a FAILED tail (the session is rolled back first), not an ambiguous STARTED one', async () => {
    const { c, exec } = await fresh();
    const brk = step120();
    expect(await stopCode(runBaseline(exec, { ...base, p5: P5, testBreakStep: brk, testBreakInTxn: true } as any))).toBe('STOP-APPLY');
    const tail = await tailOf(c); expect(tail.status).toBe('FAILED'); expect(tail.step).toBe(brk);
    expect(((await runBaseline(exec, { ...base, mode: 'recovery-plan' })) as any).analysis.classification).toBe('FAILED');
    await c.end();
  });

  it('an unknown mode is refused', async () => {
    const { c, exec } = await fresh();
    expect(await stopCode(runBaseline(exec, { ...base, mode: 'force' as any }))).toBe('STOP-AUTH');
    await c.end();
  });

  // ---------- P-HARDEN-01B (F1): a "disposable-test" label must be proven by the live database before any write ----------
  it('F1: a disposable-test executor whose live database is not local / is Supabase-shaped is refused BEFORE any write (apply and recovery-plan)', async () => {
    const { c } = await fresh();
    const written: string[] = [];
    // (a) remote client host
    const remote = new PgExecutor({ query: (...a: any[]) => { written.push(String(a[0])); return (c.query as any)(...a); }, connectionParameters: { host: 'db.knndhlczdlparjfmlxis.supabase.co' } } as any, { kind: 'disposable-test', ref: 'disposable-local' });
    for (const mode of ['apply', 'recovery-plan'] as const) expect(await stopCode(runBaseline(remote, { ...base, mode, p5: P5 }))).toBe('STOP-IDENTITY');
    expect(written.every((q) => /^\s*SELECT inet_server_addr\(\)/.test(q))).toBe(true);        // only the read-only identity probe ran
    // (b) a non-loopback server address (fake reply)
    const fake = new PgExecutor({ query: async () => ({ rows: [{ addr: '34.12.9.7/32', schemas: null, roles: null, exts: null }] }) } as any, { kind: 'disposable-test', ref: 'disposable-local' });
    expect(await stopCode(runBaseline(fake, { ...base, p5: P5 }))).toBe('STOP-IDENTITY');
    // (c) Supabase platform markers in a real local database
    for (const schema of ['storage', 'vault', 'realtime']) {
      await c.query(`CREATE SCHEMA ${schema}`);
      const e = new PgExecutor(c, { kind: 'disposable-test', ref: 'disposable-local' });
      expect(await stopCode(runBaseline(e, { ...base, p5: P5 })), schema).toBe('STOP-IDENTITY');
      await c.query(`DROP SCHEMA ${schema}`);
    }
    expect((await c.query(`SELECT to_regnamespace('phoenix_staging_ledger') AS l`)).rows[0].l).toBeNull();     // nothing was written
    expect((await c.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`)).rows[0].n).toBe(0);
    expect((await verifyDisposableIdentity(new PgExecutor(c, { kind: 'disposable-test', ref: 'disposable-local' }))).markers).toBe(0);   // the genuine local rig passes
    await c.end();
  });

  // ---------- P-HARDEN-01B (F3): the 182b overlay and the M085 verifier are hash-pinned; the verified bytes are the executed bytes ----------
  it('F3: any content change to the 182b overlay or the P4 verifier is STOP-SOURCE (plan and apply), nothing runs; CRLF checkout normalization is tolerated', async () => {
    const { c, exec } = await fresh();
    const cases: Record<string, any> = {
      'overlay appended comment': { overlay182b: (b: Buffer) => Buffer.concat([b, Buffer.from('\n-- x')]) },
      'overlay one char': { overlay182b: (b: Buffer) => Buffer.from(b.toString('utf8').replace('SELECT', 'SELEKT')) },
      'verifier one char': { verify085: (b: Buffer) => Buffer.from(b.toString('utf8').replace('EXECUTE', 'EXECUT3')) },
      'verifier weakened (always true)': { verify085: () => Buffer.from(`SELECT 'P4' AS check, true AS ok, 'x' AS detail`) },
      'verifier emptied': { verify085: () => Buffer.alloc(0) },
    };
    for (const [name, auxTamper] of Object.entries(cases)) {
      expect(await stopCode(runBaseline(exec, { ...base, p5: P5, auxTamper })), name).toBe('STOP-SOURCE');
      expect(() => planBaseline({ freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221, auxTamper }), name).toThrow(/STOP-SOURCE/);
    }
    expect((await c.query(`SELECT to_regnamespace('phoenix_staging_ledger') AS l`)).rows[0].l).toBeNull();
    expect((await c.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`)).rows[0].n).toBe(0);
    const crlf = (b: Buffer) => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
    expect(() => planBaseline({ freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221, auxTamper: { overlay182b: crlf, verify085: crlf } })).not.toThrow();
    expect(sha256(Buffer.from(bindAux().overlay182b))).toBe(PINNED_AUX.overlay182b);
    expect(sha256(Buffer.from(bindAux().verify085))).toBe(PINNED_AUX.verify085);
    await c.end();
  });

  // ---------- P-HARDEN-01 (3): public.similarity(text,text) after M001 and before R1a_06 ----------
  it('public.similarity(text,text) exists right after M001 (pg_trgm in public); the STOP-EXTENSION gate fails when pg_trgm lives elsewhere (the hosted-fidelity risk), and R1a_06 would fail', async () => {
    const { c, exec } = await fresh();
    await c.query(readFileSync(join(MIGRATIONS_DIR, readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('001_'))!), 'utf8'));
    expect((await assertSimilarityAvailable(exec)).trgm_schema).toBe('public');
    expect((await c.query(`SELECT public.similarity('abc','abd') AS s`)).rows[0].s).toBeGreaterThan(0);
    await c.query('CREATE SCHEMA IF NOT EXISTS extensions');
    await c.query('ALTER EXTENSION pg_trgm SET SCHEMA extensions');
    expect(await stopCode(assertSimilarityAvailable(exec))).toBe('STOP-EXTENSION');
    await c.end();
  });
});

describe('hosted-adapter - connection identity (pure + in-database)', () => {
  const ref = PINNED.stagingRef;
  const good = `postgresql://postgres:x@db.${ref}.supabase.co:5432/postgres?sslmode=require`;
  it('descriptor: accepts only the pinned Staging host/user (direct or pooler) with TLS; refuses Production, other refs, localhost, weak ssl, other databases', () => {
    expect(parseConnectionDescriptor(good).via).toBe('direct');
    expect(parseConnectionDescriptor(`postgresql://postgres.${ref}:x@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=verify-full`).via).toBe('pooler');
    const bad = [
      `postgresql://postgres:x@db.${PINNED.productionRef}.supabase.co:5432/postgres?sslmode=require`,
      `postgresql://postgres.${PINNED.productionRef}:x@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require`,
      `postgresql://postgres:x@db.${ref}.supabase.co:5432/postgres?application_name=${PINNED.productionRef}&sslmode=require`,
      `postgresql://postgres:x@db.otherprojectref000000.supabase.co:5432/postgres?sslmode=require`,
      `postgresql://postgres.otherprojectref000000:x@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require`,
      `postgresql://postgres:x@127.0.0.1:5432/postgres?sslmode=require`,
      `postgresql://postgres:x@db.${ref}.supabase.co:5432/postgres`,
      `postgresql://postgres:x@db.${ref}.supabase.co:5432/postgres?sslmode=disable`,
      `postgresql://postgres:x@db.${ref}.supabase.co:5432/other?sslmode=require`,
      `https://db.${ref}.supabase.co/`, 'not a url',
    ];
    for (const u of bad) { let code = 'NO-STOP'; try { parseConnectionDescriptor(u); } catch (e: any) { code = e.code; } expect(code).toBe('STOP-IDENTITY'); }
  });
  it('verifyConnectionIdentity needs a recorded cluster identity and refuses a different one', async () => {
    const fake = (row: any) => ({ kind: 'hosted', ref, query: async () => ({ rows: [row] }) });
    const row = { db: 'postgres', v: '17.11 (x)', sysid: '7000000000000000001', has_auth: true, has_storage: true, has_vault: true };
    const exp = { systemIdentifier: '7000000000000000001', pgVersionPrefix: '17.11' };
    expect((await verifyConnectionIdentity(fake(row) as any, exp)).system_identifier).toBe('7000000000000000001');
    for (const [r, e] of [[row, undefined], [row, { ...exp, systemIdentifier: '' }], [{ ...row, sysid: '7000000000000000002' }, exp], [{ ...row, v: '17.6' }, exp], [{ ...row, has_vault: false }, exp]] as any[]) {
      expect(await stopCode(verifyConnectionIdentity(fake(r) as any, e))).toBe('STOP-IDENTITY');
    }
  });
  it('runBaseline verifies the identity BEFORE anything else on a hosted executor: no descriptor, Production descriptor, wrong cluster all stop at STOP-IDENTITY; even a perfect identity ends at STOP-PHASE-P with only the read-only identity query run', async () => {
    if (!has221()) return;
    const statements: string[] = [];
    const mk = (descriptor: any, sysid: string) => Object.assign(new HostedExecutor(ref, descriptor), {
      query: async (sql: string) => { statements.push(sql); return { rows: [{ db: 'postgres', v: '17.11', sysid, has_auth: true, has_storage: true, has_vault: true }] }; } });
    const o = { freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221, mode: 'apply' as const,
      authorization: { phase: 'S1', scope: 'baseline-M001-M221', projectRef: ref, authorizedBy: 'Owner Name', authorizedOn: '2026-10-19' } };
    expect(await stopCode(runBaseline(mk(null, PINNED.stagingSystemIdentifier) as any, o))).toBe('STOP-IDENTITY');
    expect(await stopCode(runBaseline(mk({ url: `postgresql://postgres:x@db.${PINNED.productionRef}.supabase.co:5432/postgres?sslmode=require` }, PINNED.stagingSystemIdentifier) as any, o))).toBe('STOP-IDENTITY');
    expect(await stopCode(runBaseline(mk({ url: good }, '7692131729119822240') as any, o))).toBe('STOP-IDENTITY');
    expect(await stopCode(runBaseline(mk({ url: good }, PINNED.stagingSystemIdentifier) as any, o))).toBe('STOP-PHASE-P');
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.every((q) => q.includes('current_database()'))).toBe(true);
  });
});

describe('hosted-adapter - hosted connection (no network: injected client factory)', () => {
  const ref = PINNED.stagingRef;
  const PW = 'S3cretPw-never-print';
  const URL_OK = `postgresql://postgres:${PW}@db.${ref}.supabase.co:5432/postgres?sslmode=require`;
  const caDir = mkdtempSync(join(tmpdir(), 'caS1-'));
  const caPath = join(caDir, 'staging-ca.crt');
  writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nTEST-ONLY-NOT-A-REAL-CA\n-----END CERTIFICATE-----\n');
  const caSha = sha256(readFileSync(caPath));
  const factoryCalls: any[] = [];
  const fakeFactory = (rows: any = {}) => async (cfg: any) => {
    factoryCalls.push(cfg);
    return { connect: async () => undefined, end: async () => undefined, on: () => undefined, query: async (sql: string) => ({ rows: [rows] }) };
  };

  it('refuses before any network activity: Production, another project, weak TLS parameter, no/incorrect CA pin', async () => {
    const before = factoryCalls.length;
    const bad: Array<[string, any]> = [
      [`postgresql://postgres:${PW}@db.${PINNED.productionRef}.supabase.co:5432/postgres?sslmode=require`, { caPath, caSha256: caSha }],
      [`postgresql://postgres:${PW}@db.otherprojectref000000.supabase.co:5432/postgres?sslmode=require`, { caPath, caSha256: caSha }],
      [`postgresql://postgres:${PW}@db.${ref}.supabase.co:5432/postgres`, { caPath, caSha256: caSha }],
      [`postgresql://postgres:${PW}@db.${ref}.supabase.co:5432/postgres?sslmode=disable`, { caPath, caSha256: caSha }],
      [URL_OK, { caPath: undefined, caSha256: caSha }],
      [URL_OK, { caPath, caSha256: undefined }],
      [URL_OK, { caPath, caSha256: 'a'.repeat(64) }],
      [URL_OK, { caPath: join(caDir, 'missing.crt'), caSha256: caSha }],
    ];
    for (const [url, tls] of bad) expect(await stopCode(HostedExecutor.connect({ url, ...tls, clientFactory: fakeFactory() }))).toBe('STOP-IDENTITY');
    expect(factoryCalls.length).toBe(before);                              // no client was ever constructed
  });

  it('connects with a pinned CA and rejectUnauthorized:true, strips sslmode from the string, keeps the URL out of every enumerable surface', async () => {
    const ex = await HostedExecutor.connect({ url: URL_OK, caPath, caSha256: caSha.toUpperCase(), clientFactory: fakeFactory() });
    const cfg = factoryCalls[factoryCalls.length - 1];
    expect(cfg.ssl.rejectUnauthorized).toBe(true); expect(cfg.ssl.ca).toContain('TEST-ONLY-NOT-A-REAL-CA');
    expect(cfg.connectionString).not.toMatch(/sslmode/i); expect(cfg.application_name).toBe('phoenix-s1-baseline');
    expect(ex.kind).toBe('hosted'); expect(ex.ref).toBe(ref);
    expect(JSON.stringify(ex)).not.toContain(PW); expect(JSON.stringify(ex.descriptor)).not.toContain(PW);
    expect(Object.keys(ex.descriptor)).toEqual(['host', 'user', 'via']);
    expect(String(Object.keys(ex))).not.toMatch(/client/);
  });

  it('connection and query errors are redacted: the password and the URL never appear', async () => {
    const failing = async () => ({ connect: async () => { throw new Error(`could not connect to ${URL_OK}`); }, on: () => undefined, end: async () => undefined, query: async () => ({ rows: [] }) });
    let msg = ''; try { await HostedExecutor.connect({ url: URL_OK, caPath, caSha256: caSha, clientFactory: failing as any }); } catch (e: any) { msg = e.message; }
    expect(msg).toMatch(/^STOP-IDENTITY/); expect(msg).not.toContain(PW); expect(msg).not.toContain(URL_OK);
    const leaky = async () => ({ connect: async () => undefined, on: () => undefined, end: async () => undefined, query: async () => { throw new Error(`failed for password ${PW}`); } });
    const ex = await HostedExecutor.connect({ url: URL_OK, caPath, caSha256: caSha, clientFactory: leaky as any });
    let q = ''; try { await ex.query('select 1'); } catch (e: any) { q = e.message; }
    expect(q).not.toContain(PW);
  });

  it('a connected hosted executor still runs every guard: wrong cluster => STOP-IDENTITY; right cluster, no confirmation => STOP-PHASE-P with only the identity probe executed', async () => {
    if (!has221()) return;
    const statements: string[] = [];
    const mk = async (sysid: string) => HostedExecutor.connect({ url: URL_OK, caPath, caSha256: caSha, clientFactory: async () => ({
      connect: async () => undefined, end: async () => undefined, on: () => undefined,
      query: async (sql: string) => { statements.push(sql); return { rows: [{ db: 'postgres', v: '17.11', sysid, has_auth: true, has_storage: true, has_vault: true }] }; } }) as any });
    const o = { freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221, mode: 'apply' as const,
      authorization: { phase: 'S1', scope: 'baseline-M001-M221', projectRef: ref, authorizedBy: 'Owner Name', authorizedOn: '2026-10-19' } };
    expect(await stopCode(runBaseline(await mk('7692131729119822240'), o))).toBe('STOP-IDENTITY');
    expect(await stopCode(runBaseline(await mk(PINNED.stagingSystemIdentifier), o))).toBe('STOP-PHASE-P');
    expect(await stopCode(runBaseline(await mk(PINNED.stagingSystemIdentifier), { ...o, hostedApplyConfirmation: 'yes' } as any))).toBe('STOP-PHASE-P');
    expect(statements.every((q) => q.includes('current_database()'))).toBe(true);
  });

  // ---- G-LOCAL closure: the confirmation gate (fake session that answers like an EMPTY Staging; every statement is recorded) ----
  const smart = (log: string[], sysid = PINNED.stagingSystemIdentifier) => async () => ({
    connect: async () => undefined, end: async () => undefined, on: () => undefined,
    query: async (sql: string) => {
      log.push(sql);
      if (sql.includes('current_database()')) return { rows: [{ db: 'postgres', v: '17.11', sysid, has_auth: true, has_storage: true, has_vault: true }] };
      if (sql.includes('server_version_num')) return { rows: [{ v: '17.11', n: 170011 }] };
      if (sql.includes("table_schema = 'public'")) return { rows: [{ n: 0 }] };
      if (sql.includes('to_regclass')) return { rows: [{ x: false }] };
      return { rows: [{ n: 0 }] };
    } }) as any;
  const OK_AUTH = { phase: 'S1', scope: 'baseline-M001-M221', projectRef: ref, authorizedBy: 'Owner Name', authorizedOn: '2026-10-19' };
  const baseO = { freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221, mode: 'apply' as const };
  const readOnly = (log: string[]) => log.every((q) => /^\s*(SELECT|WITH)\b/i.test(q) && !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|COMMIT|SET)\b/.test(q.replace(/'[^']*'/g, '')));

  it('the exact confirmation is accepted (the run moves past the gate); a wrong, partial, or missing one is refused; nothing is written either way when later conditions fail', async () => {
    if (!has221()) return;
    for (const bad of [undefined, '', 'yes', HOSTED_CONFIRMATION + ' ', HOSTED_CONFIRMATION.replace('7692131729119822239', '7692131729119822240'), HOSTED_CONFIRMATION.toLowerCase()]) {
      const log: string[] = [];
      const ex = await HostedExecutor.connect({ url: URL_OK, caPath, caSha256: caSha, clientFactory: smart(log) });
      expect(await stopCode(runBaseline(ex, { ...baseO, authorization: OK_AUTH, hostedApplyConfirmation: bad } as any)), String(bad)).toBe('STOP-PHASE-P');
      expect(readOnly(log)).toBe(true);
    }
    // correct confirmation: the gate is passed, the next guard answers (no authorization => STOP-AUTH; TEST-ONLY authorization => STOP-AUTH)
    let log: string[] = [];
    let ex = await HostedExecutor.connect({ url: URL_OK, caPath, caSha256: caSha, clientFactory: smart(log) });
    expect(await stopCode(runBaseline(ex, { ...baseO, hostedApplyConfirmation: HOSTED_CONFIRMATION } as any))).toBe('STOP-AUTH');
    expect(await stopCode(runBaseline(ex, { ...baseO, authorization: { ...OK_AUTH, authorizedBy: 'TEST-ONLY synthetic' }, hostedApplyConfirmation: HOSTED_CONFIRMATION } as any))).toBe('STOP-AUTH');
    // valid authorization but missing P5 / bootstrap: refused BEFORE the first write
    expect(await stopCode(runBaseline(ex, { ...baseO, authorization: OK_AUTH, hostedApplyConfirmation: HOSTED_CONFIRMATION } as any))).toBe('STOP-P5');
    expect(await stopCode(runBaseline(ex, { ...baseO, authorization: OK_AUTH, hostedApplyConfirmation: HOSTED_CONFIRMATION, evidenceSha256: 'e'.repeat(64),
      p5: { ownerRef: 'Owner Name', attestedOn: '2026-10-19', projectRef: ref, evidenceSha256: 'e'.repeat(64) } } as any))).toBe('STOP-BOOTSTRAP');
    expect(readOnly(log)).toBe(true);
    // the confirmation never rescues a wrong cluster
    log = [];
    ex = await HostedExecutor.connect({ url: URL_OK, caPath, caSha256: caSha, clientFactory: smart(log, '7692131729119822240') });
    expect(await stopCode(runBaseline(ex, { ...baseO, authorization: OK_AUTH, hostedApplyConfirmation: HOSTED_CONFIRMATION } as any))).toBe('STOP-IDENTITY');
    expect(readOnly(log)).toBe(true);
  });

  it('recovery-plan on a hosted session is read-only and needs no confirmation; resume stays disabled', async () => {
    if (!has221()) return;
    const log: string[] = [];
    const ex = await HostedExecutor.connect({ url: URL_OK, caPath, caSha256: caSha, clientFactory: smart(log) });
    const r: any = await runBaseline(ex, { ...baseO, mode: 'recovery-plan' } as any);
    expect(r.analysis.classification).toBe('EMPTY'); expect(r.executed).toBe(0);
    expect(await stopCode(runBaseline(ex, { ...baseO, mode: 'resume', hostedApplyConfirmation: HOSTED_CONFIRMATION } as any))).toBe('STOP-RECOVERY');
    expect(readOnly(log)).toBe(true);
  });
});

describe('hosted-adapter - CLI (secrets only from the environment; refusals before any connection)', () => {
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const logs: string[] = []; const errs: string[] = [];
    const code = await cliMain(['--migrations', MIGRATIONS_DIR, '--freeze', join(__dirname, '..', 'staging-baseline', 'M001-M221-freeze.json'), ...args], env, { log: (m: string) => logs.push(String(m)), error: (m: string) => errs.push(String(m)) } as any);
    return { code, out: logs.join('\n'), err: errs.join('\n') };
  };
  const URL_PROD = 'postgresql://postgres:ProdPw-never-print@db.eyrzxgfkvqybjdgyphap.supabase.co:5432/postgres?sslmode=require';
  it('--apply and --resume are not modes; the default is a dry run with no connection', async () => {
    if (!has221()) return;
    expect((await run(['--apply'])).code).toBe(2); expect((await run(['--resume'])).code).toBe(2);
    const dry = await run([]); expect(dry.code).toBe(0); expect(dry.out).toContain('"steps"');
  });
  it('--apply-hosted without the exact confirmation is refused before reading any input or touching the environment', async () => {
    if (!has221()) return;
    const r = await run(['--apply-hosted', '--confirm', 'S1-APPLY-wrong'], { PHOENIX_STAGING_DB_URL: URL_PROD });
    expect(r.code).toBe(1); expect(r.err).toMatch(/^STOP-PHASE-P/); expect(r.err).not.toContain('ProdPw');
  });
  it('a Production connection string in the environment is refused with STOP-IDENTITY and never echoed (recovery-plan and apply-hosted)', async () => {
    if (!has221()) return;
    const env = { PHOENIX_STAGING_DB_URL: URL_PROD, PHOENIX_STAGING_DB_CA: 'x', PHOENIX_STAGING_DB_CA_SHA256: 'y' };
    const a = await run(['--recovery-plan'], env); expect(a.code).toBe(1); expect(a.err).toMatch(/^STOP-IDENTITY/); expect(a.err + a.out).not.toMatch(/ProdPw|eyrzx.*supabase\.co:5432/);
    const tmp = mkdtempSync(join(tmpdir(), 'cli-')); const f = join(tmp, 'x.json'); writeFileSync(f, '{}');
    const b = await run(['--apply-hosted', '--confirm', HOSTED_CONFIRMATION, '--authorization', f, '--bootstrap', f, '--p5', f, '--evidence-sha', 'a'.repeat(64)], env);
    expect(b.code).toBe(1); expect(b.err).toMatch(/^STOP-IDENTITY/); expect(b.err + b.out).not.toContain('ProdPw');
  });
  it('missing environment variables are named (never their values) and stop before any connection', async () => {
    if (!has221()) return;
    const r = await run(['--recovery-plan'], { PHOENIX_STAGING_DB_URL: `postgresql://postgres:Pw123456@db.${PINNED.stagingRef}.supabase.co:5432/postgres?sslmode=require` });
    expect(r.code).toBe(1); expect(r.err).toMatch(/PHOENIX_STAGING_DB_CA is not set/); expect(r.err).not.toContain('Pw123456');
  });
  it('the confirmation string is pinned to the Staging ref and cluster identity', () => {
    expect(HOSTED_CONFIRMATION).toBe('S1-APPLY-knndhlczdlparjfmlxis-7692131729119822239');
  });
});

describe('hosted-adapter - ledger written BEFORE A-ACL-1 (the Staging attempt that stopped at M045)', () => {
  const REF = PINNED.stagingRef;
  const o = { freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221, expectedTargetRef: REF };
  const legacy = (failAt = true) => {
    const rows: any[] = []; let seq = 0;
    const ev = (step: string, status: string, x: any = {}) => rows.push({ seq: ++seq, step, status, original_sha256: x.orig ?? null, applied_sha256: x.applied ?? null, target_ref: REF });
    for (const p of bindSources({ freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 44 })) {
      if (p.file.startsWith('004_')) { ev(p.file, 'SKIPPED', { orig: p.frozenSha }); continue; }
      const applied = p.file.startsWith('023_') ? sha256(Buffer.from(derive023(p.bytes.toString('utf8')))) : p.frozenSha;
      ev(p.file, 'STARTED'); ev(p.file, 'APPLIED', { orig: p.frozenSha, applied });
      if (p.file.startsWith('001_')) { ev('bootstrap profile', 'STARTED'); ev('bootstrap profile', 'APPLIED', { applied: BOOTSTRAP_HASH }); }
    }
    if (failAt) { ev('045_phoenix_update_my_whatsapp_phone_rpc.sql', 'STARTED'); ev('045_phoenix_update_my_whatsapp_phone_rpc.sql', 'FAILED'); }
    return rows;
  };
  it('the exact 91-row pre-A-ACL-1 ledger classifies as FAILED under the historical plan; the same rows are never accepted by apply (STOP-PARTIAL stays)', () => {
    if (!has221()) return;
    const rows = legacy(); expect(rows.length).toBe(91);
    const a: any = analyzeLedger(rows, o);
    expect(a.classification).toBe('FAILED'); expect(a.settled).toBe(45); expect(a.contract).toMatch(/pre-A-ACL-1/);
    expect(a.allowed).toMatch(/NO resume/);
  });
  it('every guard still bites on a legacy ledger: altered original/applied hash, swapped steps, a missing STARTED, another target, the alignment step injected, an event after FAILED', () => {
    if (!has221()) return;
    const mut = (f: (r: any[]) => any[]) => (analyzeLedger(f(legacy()), o) as any).classification;
    expect(mut((r) => { r.find((x) => x.step.startsWith('010_') && x.status === 'APPLIED').original_sha256 = '0'.repeat(64); return r; })).toBe('INTEGRITY-FAILURE');
    expect(mut((r) => { r.find((x) => x.step.startsWith('010_') && x.status === 'APPLIED').applied_sha256 = '1'.repeat(64); return r; })).toBe('INTEGRITY-FAILURE');
    expect(mut((r) => { const a = r.findIndex((x) => x.step.startsWith('010_')); const b = r.findIndex((x) => x.step.startsWith('011_')); [r[a].step, r[b].step] = [r[b].step, r[a].step]; return r; })).toBe('INTEGRITY-FAILURE');
    expect(mut((r) => r.filter((x) => !(x.step.startsWith('010_') && x.status === 'STARTED')))).toBe('INTEGRITY-FAILURE');
    expect(mut((r) => { r[5].target_ref = 'someone-else'; return r; })).toBe('INTEGRITY-FAILURE');
    expect(mut((r) => [...r.slice(0, 2), { seq: 99, step: 'platform default-ACL alignment', status: 'STARTED', target_ref: REF }, ...r.slice(2)])).toBe('INTEGRITY-FAILURE');
    expect(mut((r) => [...r, { seq: 500, step: '046_x.sql', status: 'STARTED', target_ref: REF }])).toBe('INTEGRITY-FAILURE');
    expect((analyzeLedger([], o) as any).classification).toBe('EMPTY');
  });
});

describe('hosted-adapter - S2 (R1-a candidates on a COMPLETE S1): pins and CLI', () => {
  const CAND_DIR = join(__dirname, '..');
  it('the six pins equal the committed candidate files; any byte change is STOP-SOURCE before anything runs', () => {
    expect(bindCandidates({ candidatesDir: CAND_DIR }).map((c) => c.file)).toEqual(CANDIDATE_PINS.map((c) => c.file));
    for (const { file } of CANDIDATE_PINS) {
      expect(() => bindCandidates({ candidatesDir: CAND_DIR, candidateTamper: { [file]: (b: Buffer) => Buffer.concat([b, Buffer.from('\n-- x')]) } }), file).toThrow(/STOP-SOURCE/);
    }
    expect(() => bindCandidates({ candidatesDir: join(CAND_DIR, 'nope') })).toThrow(/STOP-SOURCE/);
    const crlf = (b: Buffer) => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
    expect(() => bindCandidates({ candidatesDir: CAND_DIR, candidateTamper: { [CANDIDATE_PINS[0].file]: crlf } })).not.toThrow();
  });
  it('the S2 confirmation is a different phrase from S1 and pinned to the Staging cluster; the CLI refuses S2 without it (also with the S1 phrase) before any connection', async () => {
    expect(HOSTED_CONFIRMATION_S2).toBe('S2-APPLY-R1a-knndhlczdlparjfmlxis-7692131729119822239');
    expect(HOSTED_CONFIRMATION_S2).not.toBe(HOSTED_CONFIRMATION);
    if (!has221()) return;
    const logs: string[] = [];
    const run = (args: string[]) => cliMain(['--migrations', MIGRATIONS_DIR, '--freeze', join(__dirname, '..', 'staging-baseline', 'M001-M221-freeze.json'), ...args],
      { PHOENIX_STAGING_DB_URL: 'postgresql://postgres:ProdPw@db.eyrzxgfkvqybjdgyphap.supabase.co:5432/postgres?sslmode=require' }, { log: (m: string) => logs.push(String(m)), error: (m: string) => logs.push(String(m)) } as any);
    expect(await run(['--apply-candidates'])).toBe(1);
    expect(await run(['--apply-candidates', '--confirm', HOSTED_CONFIRMATION])).toBe(1);
    expect(await run(['--apply-candidates', '--confirm', HOSTED_CONFIRMATION_S2])).toBe(1);          // no --candidates-dir
    expect(logs.every((l) => !l.includes('ProdPw'))).toBe(true);
    expect(logs.some((l) => /STOP-PHASE-P/.test(l)) && logs.some((l) => /STOP-SOURCE/.test(l))).toBe(true);
  });
});

const runS2 = rigAvailable() && has221() ? describe : describe.skip;
runS2('hosted-adapter - S2 on a disposable PostgreSQL', { timeout: 900_000 }, () => {
  const SUPA = `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role`;
  const s1 = (extra: any = {}) => ({ freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221, mode: 'apply' as const, authorization: AUTH, evidenceSha256: EVID, bootstrap: BOOT, p5: P5, ...extra });
  const AUTH2 = { phase: 'S2', scope: 'candidates-R1a_01-06', projectRef: 'disposable-local', authorizedBy: 'TEST-ONLY (synthetic, disposable rig)', authorizedOn: '2026-10-20' };
  const s2 = (extra: any = {}) => ({ freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221, mode: 'apply-candidates' as const, candidates: true, candidatesDir: join(__dirname, '..'), authorization: AUTH2, ...extra });
  async function afterS1() {
    const c = await freshRigDb({}); await c.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [BOOT_ID, BOOT.email]);
    const exec = new PgExecutor(c, { kind: 'disposable-test', ref: 'disposable-local' });
    await runBaseline(exec, s1({ testHook: async (f: string, e: any) => { if (f.startsWith('001_')) await e.query(SUPA); } }));      // Supabase-like platform defaults + A-ACL-1 inside S1
    return { c, exec };
  }
  const r1Tables = async (c: any) => (await c.query(`SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND tablename IN ('central_needs_material_requests','central_needs_manual_need_events')`)).rows[0].n;

  it('refusals before any write: no/other-phase/other-scope/other-target authorization, tampered candidate, R1-a objects already present, S1 not complete', async () => {
    const { c, exec } = await afterS1();
    const before = (await c.query(`SELECT count(*)::int n FROM phoenix_staging_ledger.baseline_steps`)).rows[0].n;
    for (const authorization of [undefined, { ...AUTH2, phase: 'S1' }, { ...AUTH2, scope: 'baseline-M001-M221' }, { ...AUTH2, projectRef: PINNED.stagingRef }, { ...AUTH2, authorizedBy: 'A Real Owner' }, { ...AUTH2, authorizedOn: '' }]) {
      expect(await stopCode(runBaseline(exec, s2({ authorization }))), JSON.stringify(authorization)).toBe('STOP-AUTH');
    }
    expect(await stopCode(runBaseline(exec, s2({ candidateTamper: { [CANDIDATE_PINS[2].file]: (b: Buffer) => Buffer.concat([b, Buffer.from('\n-- x')]) } })))).toBe('STOP-SOURCE');
    await c.query(`CREATE TABLE public.central_needs_material_requests (id int)`);
    expect(await stopCode(runBaseline(exec, s2()))).toBe('STOP-TARGET');
    await c.query(`DROP TABLE public.central_needs_material_requests`);
    expect((await c.query(`SELECT count(*)::int n FROM phoenix_staging_ledger.baseline_steps`)).rows[0].n).toBe(before);   // nothing was written
    expect(await r1Tables(c)).toBe(0);
    await c.query(`DELETE FROM phoenix_staging_ledger.baseline_steps WHERE seq > (SELECT max(seq) - 5 FROM phoenix_staging_ledger.baseline_steps)`);   // S1 not complete
    expect(await stopCode(runBaseline(exec, s2()))).toBe('STOP-LEDGER');
    await c.end();
  });

  it('applies the six candidates in order on the Supabase-like baseline: ledger COMPLETE with the candidate plan, R1 objects exist, anon has no central-needs EXECUTE, a second run is refused', async () => {
    const { c, exec } = await afterS1();
    const out: any = await runBaseline(exec, s2());
    expect(out.applied).toBe(6); expect(out.aclSnapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    const led = (await c.query(`SELECT step, status FROM phoenix_staging_ledger.baseline_steps ORDER BY seq DESC LIMIT 12`)).rows.reverse();
    expect(led.map((r: any) => `${r.step.slice(0, 7)}/${r.status}`)).toEqual(CANDIDATE_PINS.flatMap((p) => [`${p.file.slice(0, 7)}/STARTED`, `${p.file.slice(0, 7)}/APPLIED`]));
    expect(((await runBaseline(exec, s2({ mode: 'recovery-plan' } as any))) as any).analysis.classification).toBe('COMPLETE');
    expect(await r1Tables(c)).toBe(2);
    expect((await c.query(`SELECT count(*)::int n FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE '%central_needs%' AND has_function_privilege('anon', p.oid, 'EXECUTE')`)).rows[0].n).toBe(0);
    expect(await stopCode(runBaseline(exec, s2()))).toBe('STOP-LEDGER');           // no re-run, no resume
    await c.end();
  });

  it('a candidate that fails stops the run at once: earlier files stay APPLIED, the failing one is FAILED (session rolled back), later ones never start, and nothing continues it', async () => {
    const { c, exec } = await afterS1();
    expect(await stopCode(runBaseline(exec, s2({ testBreakStep: CANDIDATE_PINS[2].file })))).toBe('STOP-APPLY');
    const rows = (await c.query(`SELECT step, status FROM phoenix_staging_ledger.baseline_steps ORDER BY seq DESC LIMIT 5`)).rows.reverse().map((r: any) => `${r.step.slice(0, 7)}/${r.status}`);
    expect(rows).toEqual(['R1a_01_/APPLIED', 'R1a_02_/STARTED', 'R1a_02_/APPLIED', 'R1a_03_/STARTED', 'R1a_03_/FAILED']);
    expect(((await runBaseline(exec, s2({ mode: 'recovery-plan' } as any))) as any).analysis.classification).toBe('FAILED');
    expect(await stopCode(runBaseline(exec, s2()))).toBe('STOP-LEDGER');
    await c.end();
  });
});

describe('hosted-adapter - S3 (R1-b files, then one organization activation): pins and CLI', () => {
  const CAND_DIR = join(__dirname, '..');
  const ORG = '00000000-0000-0000-0000-0000000c9001';
  it('the two R1-b pins equal the committed files; any byte change is STOP-SOURCE; the S3a/S3b phrases are distinct, pinned to the cluster, and S3b names the organization', () => {
    expect(bindCandidates({ candidatesDir: CAND_DIR, set: 'R1b' }).map((c) => c.file)).toEqual(R1B_PINS.map((c) => c.file));
    for (const { file } of R1B_PINS) expect(() => bindCandidates({ candidatesDir: CAND_DIR, set: 'R1b', candidateTamper: { [file]: (b: Buffer) => Buffer.concat([b, Buffer.from('\n-- x')]) } }), file).toThrow(/STOP-SOURCE/);
    expect(HOSTED_CONFIRMATION_S3A).toBe('S3A-APPLY-R1b-knndhlczdlparjfmlxis-7692131729119822239');
    expect(hostedConfirmationS3B(ORG)).toBe(`S3B-ACTIVATE-knndhlczdlparjfmlxis-7692131729119822239-${ORG}`);
    expect(new Set([HOSTED_CONFIRMATION, HOSTED_CONFIRMATION_S2, HOSTED_CONFIRMATION_S3A, hostedConfirmationS3B(ORG)]).size).toBe(4);
    expect(() => planBaseline({ freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221, r1b: true, candidatesDir: CAND_DIR })).toThrow(/STOP-SOURCE/);          // R1-b without R1-a in the plan
  });
  it('the CLI refuses S3a/S3b without their own exact phrase (also with the S1/S2 phrase, or another organization) before any connection, and never echoes a secret', async () => {
    if (!has221()) return;
    const logs: string[] = [];
    const run = (args: string[]) => cliMain(['--migrations', MIGRATIONS_DIR, '--freeze', join(__dirname, '..', 'staging-baseline', 'M001-M221-freeze.json'), '--candidates-dir', CAND_DIR, ...args],
      { PHOENIX_STAGING_DB_URL: 'postgresql://postgres:ProdPw@db.eyrzxgfkvqybjdgyphap.supabase.co:5432/postgres?sslmode=require' }, { log: (m: string) => logs.push(String(m)), error: (m: string) => logs.push(String(m)) } as any);
    expect(await run(['--apply-r1b'])).toBe(1);
    expect(await run(['--apply-r1b', '--confirm', HOSTED_CONFIRMATION_S2])).toBe(1);
    expect(await run(['--activate-org', ORG])).toBe(1);
    expect(await run(['--activate-org', ORG, '--confirm', hostedConfirmationS3B('00000000-0000-0000-0000-0000000c9002')])).toBe(1);
    expect(await run(['--activate-org', ORG, '--confirm', HOSTED_CONFIRMATION_S3A])).toBe(1);
    expect(logs.every((l) => !l.includes('ProdPw'))).toBe(true);
    expect(logs.filter((l) => /STOP-PHASE-P/.test(l)).length).toBe(5);
  });
  it('S3p has its own phrase naming the organization (distinct from every other phrase); the CLI refuses it without that exact phrase before any connection', async () => {
    if (!has221()) return;
    expect(hostedConfirmationS3P(ORG)).toBe(`S3P-PROVISION-knndhlczdlparjfmlxis-7692131729119822239-${ORG}`);
    expect(new Set([HOSTED_CONFIRMATION, HOSTED_CONFIRMATION_S2, HOSTED_CONFIRMATION_S3A, hostedConfirmationS3B(ORG), hostedConfirmationS3P(ORG)]).size).toBe(5);
    const logs: string[] = [];
    const run = (args: string[]) => cliMain(['--migrations', MIGRATIONS_DIR, '--freeze', join(__dirname, '..', 'staging-baseline', 'M001-M221-freeze.json'), '--candidates-dir', CAND_DIR, ...args],
      { PHOENIX_STAGING_DB_URL: 'postgresql://postgres:ProdPw@db.eyrzxgfkvqybjdgyphap.supabase.co:5432/postgres?sslmode=require' }, { log: (m: string) => logs.push(String(m)), error: (m: string) => logs.push(String(m)) } as any);
    expect(await run(['--provision-org', ORG])).toBe(1);
    expect(await run(['--provision-org', ORG, '--confirm', hostedConfirmationS3B(ORG)])).toBe(1);
    expect(await run(['--provision-org', ORG, '--confirm', hostedConfirmationS3P('00000000-0000-0000-0000-0000000c9002')])).toBe(1);
    expect(logs.every((l) => !l.includes('ProdPw'))).toBe(true);
    expect(logs.filter((l) => /STOP-PHASE-P/.test(l)).length).toBe(3);
  });
  it('the minimal key sets never overlap on a dangerous key (SoD) and contain nothing broad', () => {
    const all = [...PROVISION_KEYS.maker, ...PROVISION_KEYS.checker];
    expect(PROVISION_KEYS.maker.filter((k) => PROVISION_KEYS.checker.includes(k))).toEqual(['central_needs.view']);
    expect(all.every((k) => /^central_needs\.[a-z_.]+$/.test(k))).toBe(true);
    expect(PROVISION_KEYS.maker).not.toContain('central_needs.approve');
    expect(PROVISION_KEYS.checker).not.toContain('central_needs.manual_need.set');
    expect(PROVISION_ITEMS.length).toBe(3);
  });
});

const runS3 = rigAvailable() && has221() ? describe : describe.skip;
runS3('hosted-adapter - S3 on a disposable PostgreSQL', { timeout: 900_000 }, () => {
  const SUPA = `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role`;
  const T = 'TEST-ONLY (synthetic, disposable rig)';
  const cand = join(__dirname, '..');
  const base = (extra: any = {}) => ({ freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221, candidatesDir: cand, ...extra });
  const s1 = (extra: any = {}) => base({ mode: 'apply', authorization: AUTH, evidenceSha256: EVID, bootstrap: BOOT, p5: P5, ...extra });
  const s2 = (extra: any = {}) => base({ mode: 'apply-candidates', candidates: true, authorization: { phase: 'S2', scope: 'candidates-R1a_01-06', projectRef: 'disposable-local', authorizedBy: T, authorizedOn: '2026-10-20' }, ...extra });
  const s3a = (extra: any = {}) => base({ mode: 'apply-r1b', candidates: true, r1b: true, authorization: { phase: 'S3', scope: 'candidates-R1b_01-02', projectRef: 'disposable-local', authorizedBy: T, authorizedOn: '2026-10-20' }, ...extra });
  const ORG = '00000000-0000-0000-0000-0000000c9101', ORG_CARE = '00000000-0000-0000-0000-0000000c9102';
  const U = { maker: '00000000-0000-0000-0000-0000000c9201', checker: '00000000-0000-0000-0000-0000000c9202', both: '00000000-0000-0000-0000-0000000c9203' };
  const s3b = (extra: any = {}) => base({ mode: 'activate-org', candidates: true, r1b: true, organizationId: ORG, authorization: { phase: 'S3B', scope: 'activate-manual-cutover', projectRef: 'disposable-local', organizationId: ORG, authorizedBy: T, authorizedOn: '2026-10-20' }, ...extra });
  async function build(upToStep: 's1' | 's2') {
    const c = await freshRigDb({}); await c.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [BOOT_ID, BOOT.email]);
    const exec = new PgExecutor(c, { kind: 'disposable-test', ref: 'disposable-local' });
    await runBaseline(exec, s1({ testHook: async (f: string, e: any) => { if (f.startsWith('001_')) await e.query(SUPA); } }));
    if (upToStep === 's2') await runBaseline(exec, s2());
    return { c, exec };
  }
  const writersAuth = async (c: any) => (await c.query(`SELECT count(*)::int n FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname ~ '^phoenix_central_needs_(open_manual|carry_forward|add_manual|correct_manual|void_manual|withdraw_draft|acknowledge_manual|create_material|update_material|submit_material|start_material|request_material|resolve_material|approve_new|reject_material|cancel_material|link_material)' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')`)).rows[0].n;
  const fixtures = async (c: any, opts: { maker?: boolean; checker?: boolean; both?: boolean } = {}) => {
    await c.query('BEGIN'); await c.query(`SET LOCAL session_replication_role = replica`);
    await c.query(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES ($1,'S3 PDA','دائرة','s3-pda','pharmacy_department_authority',NULL),($2,'S3 Care','مؤسسة','s3-care','care_institution','hospital') ON CONFLICT DO NOTHING`, [ORG, ORG_CARE]);
    for (const [id, who] of [[U.maker, 'maker'], [U.checker, 'checker'], [U.both, 'both']] as const) {
      await c.query(`INSERT INTO auth.users (id, email) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, `${who}@s3.rig`]);
      await c.query(`INSERT INTO profiles (id, full_name, role, status, organization_id) VALUES ($1,$2,'central_warehouse_manager','active',$3) ON CONFLICT (id) DO UPDATE SET role='central_warehouse_manager', status='active', organization_id=$3`, [id, who, ORG]);
    }
    const give = async (id: string, keys: string[]) => { for (const k of keys) await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true) ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true`, [id, `central_needs.${k}`]); };
    if (opts.maker) await give(U.maker, ['view', 'edit', 'manual_need.set']);
    if (opts.checker) await give(U.checker, ['view', 'approve']);
    if (opts.both) await give(U.both, ['view', 'edit', 'manual_need.set', 'approve']);
    await c.query('COMMIT');
  };

  describe('S3a then S3b on one Supabase-like database', () => {
    let A: any;
    beforeAll(async () => { A = await build('s2'); }, 600_000);
    afterAll(async () => { await A?.c?.end().catch(() => undefined); });

    it('S3a refusals before any write: authorization variants, tampered file, R1-b objects already present, a failing capability seal', async () => {
      const { c, exec } = A; const before = (await c.query(`SELECT count(*)::int n FROM phoenix_staging_ledger.baseline_steps`)).rows[0].n;
      for (const authorization of [undefined, { phase: 'S2', scope: 'candidates-R1a_01-06', projectRef: 'disposable-local', authorizedBy: T, authorizedOn: '2026-10-20' }, { phase: 'S3', scope: 'candidates-R1b_01-02', projectRef: PINNED.stagingRef, authorizedBy: T, authorizedOn: '2026-10-20' },
        { phase: 'S3', scope: 'candidates-R1b_01-02', projectRef: 'disposable-local', authorizedBy: 'A Real Owner', authorizedOn: '2026-10-20' }, { phase: 'S3', scope: 'candidates-R1b_01-02', projectRef: 'disposable-local', authorizedBy: T, authorizedOn: '' }]) {
        expect(await stopCode(runBaseline(exec, s3a({ authorization }))), JSON.stringify(authorization)).toBe('STOP-AUTH');
      }
      expect(await stopCode(runBaseline(exec, s3a({ candidateTamper: { [R1B_PINS[1].file]: (b: Buffer) => Buffer.concat([b, Buffer.from('\n-- x')]) } })))).toBe('STOP-SOURCE');
      await c.query(`CREATE FUNCTION phoenix_private.central_needs_activate_manual_cutover_v1(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$`);
      expect(await stopCode(runBaseline(exec, s3a()))).toBe('STOP-TARGET');
      await c.query(`DROP FUNCTION phoenix_private.central_needs_activate_manual_cutover_v1(uuid)`);
      expect((await c.query(`SELECT count(*)::int n FROM phoenix_staging_ledger.baseline_steps`)).rows[0].n).toBe(before);
      expect(await writersAuth(c)).toBe(0);
    });

    it('S3a applies R1b_01 then R1b_02: ledger COMPLETE with the R1-b plan, the 18 writers become authenticated-only, the activation routine is not API-reachable, the seal is clean, a second run is refused', async () => {
      const { c, exec } = A;
      const out: any = await runBaseline(exec, s3a());
      expect(out.applied).toBe(2);
      const led = (await c.query(`SELECT step, status FROM phoenix_staging_ledger.baseline_steps ORDER BY seq DESC LIMIT 4`)).rows.reverse().map((r: any) => `${r.step.slice(0, 6)}/${r.status}`);
      expect(led).toEqual(['R1b_01/STARTED', 'R1b_01/APPLIED', 'R1b_02/STARTED', 'R1b_02/APPLIED']);
      expect(((await runBaseline(exec, s3a({ mode: 'recovery-plan' } as any))) as any).analysis.classification).toBe('COMPLETE');
      expect(await writersAuth(c)).toBe(18);
      expect((await c.query(`SELECT count(*)::int n FROM pg_proc p WHERE p.proname ~ '^phoenix_central_needs_' AND p.pronamespace='public'::regnamespace AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE')) AND p.proname ~ '(add_manual|open_manual|material_request_draft|approve_new)'`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int n FROM pg_proc p WHERE p.oid='phoenix_private.central_needs_activate_manual_cutover_v1(uuid)'::regprocedure AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE'))`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int n FROM phoenix_private.central_needs_capability_breaches_v1()`)).rows[0].n).toBe(0);
      expect(await stopCode(runBaseline(exec, s3a()))).toBe('STOP-LEDGER');
    });

    it('S3b refusals before any write: authorization/organization mismatch, no such organization, not a pharmacy department, no staffing, one person in both roles, a pending Excel draft', async () => {
      const { c, exec } = A; const before = (await c.query(`SELECT count(*)::int n FROM phoenix_staging_ledger.baseline_steps`)).rows[0].n;
      expect(await stopCode(runBaseline(exec, s3b({ authorization: undefined })))).toBe('STOP-AUTH');
      expect(await stopCode(runBaseline(exec, s3b({ authorization: { phase: 'S3', scope: 'candidates-R1b_01-02', projectRef: 'disposable-local', organizationId: ORG, authorizedBy: T, authorizedOn: '2026-10-20' } })))).toBe('STOP-AUTH');
      expect(await stopCode(runBaseline(exec, s3b({ authorization: { phase: 'S3B', scope: 'activate-manual-cutover', projectRef: 'disposable-local', organizationId: ORG_CARE, authorizedBy: T, authorizedOn: '2026-10-20' } })))).toBe('STOP-AUTH');
      expect(await stopCode(runBaseline(exec, s3b({ organizationId: 'not-a-uuid' })))).toBe('STOP-AUTH');
      expect(await stopCode(runBaseline(exec, s3b()))).toBe('STOP-TARGET');                                                  // organization does not exist yet
      await fixtures(c);                                                                                                    // organizations + users, NO keys
      expect(await stopCode(runBaseline(exec, s3b({ organizationId: ORG_CARE, authorization: { phase: 'S3B', scope: 'activate-manual-cutover', projectRef: 'disposable-local', organizationId: ORG_CARE, authorizedBy: T, authorizedOn: '2026-10-20' } })))).toBe('STOP-TARGET');
      expect(await stopCode(runBaseline(exec, s3b()))).toBe('STOP-STAFFING');                                               // nobody holds any key
      await fixtures(c, { both: true });
      expect(await stopCode(runBaseline(exec, s3b()))).toBe('STOP-STAFFING');                                               // the same person is maker and checker
      await c.query(`DELETE FROM profile_permission_overrides WHERE profile_id = $1`, [U.both]);                            // that person is not staffing anything any more
      await fixtures(c, { maker: true });
      expect(await stopCode(runBaseline(exec, s3b()))).toBe('STOP-STAFFING');                                               // a maker, but no checker at all
      await fixtures(c, { checker: true });
      await c.query('BEGIN'); await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`INSERT INTO central_needs_plans (id, organization_id, plan_year, status) VALUES ('00000000-0000-0000-0000-0000000c9301', $1, 2026, 'draft')`, [ORG]);
      await c.query(`INSERT INTO central_needs_plan_revisions (id, plan_id, organization_id, revision_number, status, source_mode) VALUES ('00000000-0000-0000-0000-0000000c9302','00000000-0000-0000-0000-0000000c9301',$1,1,'draft','excel')`, [ORG]);
      await c.query('COMMIT');
      expect(await stopCode(runBaseline(exec, s3b()))).toBe('STOP-TARGET');                                                 // pending Excel draft
      await c.query('BEGIN'); await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`DELETE FROM central_needs_plan_revisions WHERE id='00000000-0000-0000-0000-0000000c9302'`); await c.query(`DELETE FROM central_needs_plans WHERE id='00000000-0000-0000-0000-0000000c9301'`); await c.query('COMMIT');
      expect((await c.query(`SELECT count(*)::int n FROM phoenix_staging_ledger.baseline_steps`)).rows[0].n).toBe(before);   // nothing was written by any refusal
      expect((await c.query(`SELECT phoenix_cn_policy.excel_read_restriction_state($1::uuid) AS s`, [ORG])).rows[0].s).not.toBe('active');
    });

    it('S3b activates exactly the named organization: marker + inventory written, ledgered, ledger COMPLETE with the activation step, the other organization untouched, replay refused', async () => {
      const { c, exec } = A;
      const out: any = await runBaseline(exec, s3b());
      expect(out.executed).toBe(1);
      expect((await c.query(`SELECT phoenix_cn_policy.excel_read_restriction_state($1::uuid) AS s`, [ORG])).rows[0].s).toBe('active');
      expect((await c.query(`SELECT phoenix_cn_policy.excel_read_restriction_state($1::uuid) AS s`, [ORG_CARE])).rows[0].s).not.toBe('active');
      expect((await c.query(`SELECT count(*)::int n FROM central_needs_cutover_inventory WHERE organization_id=$1 AND entry_kind='activation_marker'`, [ORG])).rows[0].n).toBe(1);
      const tail = (await c.query(`SELECT step, status FROM phoenix_staging_ledger.baseline_steps ORDER BY seq DESC LIMIT 2`)).rows.reverse().map((r: any) => `${r.step.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, 'ORG')}/${r.status}`);
      expect(tail).toEqual(['activate-manual-cutover:ORG/STARTED', 'activate-manual-cutover:ORG/APPLIED']);
      expect(((await runBaseline(exec, s3b({ mode: 'recovery-plan' } as any))) as any).analysis.classification).toBe('COMPLETE');
      expect(await stopCode(runBaseline(exec, s3b()))).toBe('STOP-TARGET');                                                 // already active: no implicit replay
    });
  });

  describe('S3p (provision the isolated test organization) then S3b, with NO hand-made fixtures', () => {
    const PORG = '00000000-0000-0000-0000-0000000c9501', PBEN = '00000000-0000-0000-0000-0000000c9502';
    const MK = '00000000-0000-0000-0000-0000000c9511', CK = '00000000-0000-0000-0000-0000000c9512';
    const authP = (extra: any = {}) => ({ phase: 'S3P', scope: 'provision-test-org', projectRef: 'disposable-local', organizationId: PORG, beneficiaryOrganizationId: PBEN, makerEmail: 'Maker@s3p.rig', checkerEmail: 'checker@s3p.rig', authorizedBy: T, authorizedOn: '2026-10-20', ...extra });
    const s3p = (extra: any = {}) => base({ mode: 'provision-org', candidates: true, r1b: true, organizationId: PORG, authorization: authP(), ...extra });
    const s3bP = () => base({ mode: 'activate-org', candidates: true, r1b: true, organizationId: PORG, authorization: { phase: 'S3B', scope: 'activate-manual-cutover', projectRef: 'disposable-local', organizationId: PORG, authorizedBy: T, authorizedOn: '2026-10-20' } });
    let P: any;
    beforeAll(async () => { P = await build('s2'); await runBaseline(P.exec, s3a()); }, 600_000);
    afterAll(async () => { await P?.c?.end().catch(() => undefined); });
    const ledgerN = async (c: any) => (await c.query(`SELECT count(*)::int n FROM phoenix_staging_ledger.baseline_steps`)).rows[0].n;
    const snap = async (c: any) => JSON.stringify((await c.query(`SELECT (SELECT count(*) FROM organizations) o, (SELECT count(*) FROM profile_permission_overrides) k, (SELECT count(*) FROM central_items WHERE name LIKE 'R1-ACCEPTANCE%') i, (SELECT string_agg(role||organization_id::text, ',' ORDER BY id) FROM profiles) p`)).rows[0]);

    it('refuses, writing nothing: bad authorization, missing/duplicate Auth users, same account twice, owner as maker, already-assigned profile, non-pristine target', async () => {
      const { c, exec } = P; const n0 = await ledgerN(c); const s0 = await snap(c);
      for (const authorization of [undefined, authP({ phase: 'S3B' }), authP({ projectRef: PINNED.stagingRef }), authP({ authorizedBy: 'A Real Owner' }), authP({ organizationId: PBEN })]) {
        expect(await stopCode(runBaseline(exec, s3p({ authorization }))), JSON.stringify(authorization)).toBe('STOP-AUTH');
      }
      expect(await stopCode(runBaseline(exec, s3p({ authorization: authP({ beneficiaryOrganizationId: PORG }) })))).toBe('STOP-AUTH');
      expect(await stopCode(runBaseline(exec, s3p({ authorization: authP({ checkerEmail: 'MAKER@s3p.rig' }) })))).toBe('STOP-AUTH');           // one person in both roles
      expect(await stopCode(runBaseline(exec, s3p({ authorization: authP({ makerEmail: 'not-an-email' }) })))).toBe('STOP-AUTH');
      expect(await stopCode(runBaseline(exec, s3p()))).toBe('STOP-STAFFING');                                                             // the two Auth users do not exist yet
      await c.query(`INSERT INTO auth.users (id,email) VALUES ($1,'maker@s3p.rig')`, [MK]);
      expect(await stopCode(runBaseline(exec, s3p()))).toBe('STOP-STAFFING');                                                             // only one of them
      expect(await stopCode(runBaseline(exec, s3p({ authorization: authP({ makerEmail: BOOT.email, checkerEmail: 'maker@s3p.rig' }) })))).toBe('STOP-STAFFING');   // the bootstrap Owner is a super_admin
      await c.query(`INSERT INTO auth.users (id,email) VALUES ($1,'checker@s3p.rig')`, [CK]);
      expect(await ledgerN(c)).toBe(n0); expect(await snap(c)).toBe(s0);
    });

    it('provisions exactly: 2 organizations, 2 profiles assigned, 3+3 minimal keys, 3 synthetic items; ledgered; seal clean; nothing activated; the owner profile untouched', async () => {
      const { c, exec } = P;
      const ownerBefore = JSON.stringify((await c.query(`SELECT id, role, status, organization_id FROM profiles WHERE id = $1`, [BOOT_ID])).rows);
      const out: any = await runBaseline(exec, s3p());
      expect(out).toMatchObject({ executed: 1, keys: 6, items: 3, organizationId: PORG });
      expect((await c.query(`SELECT organization_kind k FROM organizations WHERE id IN ($1,$2) ORDER BY k`, [PORG, PBEN])).rows.map((r: any) => r.k)).toEqual(['care_institution', 'pharmacy_department_authority']);
      expect((await c.query(`SELECT role FROM profiles WHERE organization_id = $1 AND status='active' ORDER BY role`, [PORG])).rows.map((r: any) => r.role)).toEqual(['central_warehouse_manager', 'super_admin']);
      const keys = (await c.query(`SELECT profile_id, array_agg(permission_key ORDER BY permission_key) ks FROM profile_permission_overrides GROUP BY 1`)).rows;
      const byId = Object.fromEntries(keys.map((r: any) => [r.profile_id, r.ks]));
      expect(byId[MK]).toEqual([...PROVISION_KEYS.maker].sort()); expect(byId[CK]).toEqual([...PROVISION_KEYS.checker].sort());
      expect((await c.query(`SELECT count(*)::int n FROM central_items WHERE name LIKE 'R1-ACCEPTANCE TEST%'`)).rows[0].n).toBe(3);
      expect((await c.query(`SELECT count(*)::int n FROM phoenix_private.central_needs_capability_breaches_v1()`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT phoenix_cn_policy.excel_read_restriction_state($1::uuid) s`, [PORG])).rows[0].s).not.toBe('active');
      expect(JSON.stringify((await c.query(`SELECT id, role, status, organization_id FROM profiles WHERE id = $1`, [BOOT_ID])).rows)).toBe(ownerBefore);
      const tail = (await c.query(`SELECT step, status FROM phoenix_staging_ledger.baseline_steps ORDER BY seq DESC LIMIT 2`)).rows.reverse().map((r: any) => `${r.step.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, 'ORG')}/${r.status}`);
      expect(tail).toEqual(['provision-test-org:ORG/STARTED', 'provision-test-org:ORG/APPLIED']);
      expect(((await runBaseline(exec, s3p({ mode: 'recovery-plan' } as any))) as any).analysis.classification).toBe('COMPLETE');
      expect(await stopCode(runBaseline(exec, s3p()))).toBe('STOP-TARGET');                                                               // a second run duplicates nothing
    });

    it('the provisioned staffing satisfies the S3b gate as is: activation succeeds with no extra fixtures and ends COMPLETE', async () => {
      const { c, exec } = P;
      const out: any = await runBaseline(exec, s3bP());
      expect(out.executed).toBe(1);
      expect((await c.query(`SELECT phoenix_cn_policy.excel_read_restriction_state($1::uuid) s`, [PORG])).rows[0].s).toBe('active');
      expect(await stopCode(runBaseline(exec, s3bP()))).toBe('STOP-TARGET');
    }, 120_000);

    it('a failure inside the transaction rolls every data write back and ends FAILED (nothing half-provisioned)', async () => {
      await P.c.end().catch(() => undefined);                                                                            // freshRigDb recreates the shared test database: release this connection first
      const A2 = await build('s2'); await runBaseline(A2.exec, s3a());
      await A2.c.query(`INSERT INTO auth.users (id,email) VALUES ($1,'maker@s3p.rig'),($2,'checker@s3p.rig')`, [MK, CK]);
      await A2.c.query(`CREATE OR REPLACE FUNCTION public.s3p_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
      await A2.c.query(`CREATE TRIGGER s3p_boom BEFORE INSERT ON central_items FOR EACH ROW EXECUTE FUNCTION public.s3p_boom()`);
      expect(await stopCode(runBaseline(A2.exec, s3p()))).toBe('STOP-APPLY');
      expect((await A2.c.query(`SELECT (SELECT count(*)::int FROM organizations) o, (SELECT count(*)::int FROM profile_permission_overrides) k`)).rows[0]).toEqual({ o: 0, k: 0 });
      expect((await A2.c.query(`SELECT count(*)::int n FROM profiles WHERE organization_id IS NOT NULL`)).rows[0].n).toBe(0);
      const rows = (await A2.c.query(`SELECT status FROM phoenix_staging_ledger.baseline_steps ORDER BY seq DESC LIMIT 2`)).rows.reverse().map((r: any) => r.status);
      expect(rows).toEqual(['STARTED', 'FAILED']);
      expect(((await runBaseline(A2.exec, s3p({ mode: 'recovery-plan' } as any))) as any).analysis.classification).toBe('FAILED');
      await A2.c.end();
    }, 600_000);
  });

  it('S3a is refused while S2 is incomplete; a failing R1b_02 stops the run (R1b_01 stays APPLIED, R1b_02 FAILED), nothing continues it', async () => {
    const { c, exec } = await build('s1');
    expect(await stopCode(runBaseline(exec, s3a()))).toBe('STOP-LEDGER');                                                    // S1 only
    await runBaseline(exec, s2());
    expect(await stopCode(runBaseline(exec, s3a({ testBreakStep: R1B_PINS[1].file })))).toBe('STOP-APPLY');
    const rows = (await c.query(`SELECT step, status FROM phoenix_staging_ledger.baseline_steps ORDER BY seq DESC LIMIT 4`)).rows.reverse().map((r: any) => `${r.step.slice(0, 6)}/${r.status}`);
    expect(rows).toEqual(['R1b_01/STARTED', 'R1b_01/APPLIED', 'R1b_02/STARTED', 'R1b_02/FAILED']);
    expect(((await runBaseline(exec, s3a({ mode: 'recovery-plan' } as any))) as any).analysis.classification).toBe('FAILED');
    expect(await stopCode(runBaseline(exec, s3a()))).toBe('STOP-LEDGER');
    await c.end();
  });
});
