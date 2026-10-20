/**
 * F3 - the R1 functional-acceptance journey, rehearsed LOCALLY against a disposable PostgreSQL that went through the exact Staging path
 * (S1 -> S2 -> S3a -> S3p provisioning -> S3b activation), with the maker/checker/anon actors impersonated per call as PostgREST does.
 * No hosted project is contacted. The same journey file is what the Staging runner executes with real sign-ins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { rigAvailable, MIGRATIONS_DIR, freshRigDb } from '../../../tools/pg-rig/rig.mjs';
import { PgExecutor, runBaseline } from '../staging-baseline/hosted-adapter/hosted-adapter.mjs';
import { runJourney } from '../staging-baseline/hosted-adapter/functional-journey.mjs';
import { acceptanceMain, hostedConfirmationS3C, stagingTransport } from '../staging-baseline/hosted-adapter/functional-acceptance.mjs';
import { PINNED, hostedConfirmationS3P } from '../staging-baseline/hosted-adapter/hosted-adapter.mjs';

const FREEZE = JSON.parse(readFileSync(join(__dirname, '..', 'staging-baseline', 'M001-M221-freeze.json'), 'utf8'));
const has221 = () => readdirSync(MIGRATIONS_DIR).some((f) => f.startsWith('221_'));
const T = 'TEST-ONLY (synthetic, disposable rig)';
const EVID = 'e'.repeat(64);
const BOOT_ID = '00000000-0000-0000-0000-00000000b007', OWNER_EMAIL = 'owner-test@rig.local';
const SUPA = `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role`;
const ORG = '00000000-0000-0000-0000-0000000c9601', BEN = '00000000-0000-0000-0000-0000000c9602';
const MK = '00000000-0000-0000-0000-0000000c9611', CK = '00000000-0000-0000-0000-0000000c9612';
const cand = join(__dirname, '..');
const A = (phase: string, scope: string, extra: any = {}) => ({ phase, scope, projectRef: 'disposable-local', authorizedBy: T, authorizedOn: '2026-10-20', ...extra });
const base = (extra: any) => ({ freeze: FREEZE, migrationsDir: MIGRATIONS_DIR, upTo: 221, candidatesDir: cand, ...extra });

/** The local transport: one transaction per call, role + subject set exactly like PostgREST does; a refusal rolls back. */
export function localTransport(c: any, ids: Record<string, string | null>) {
  const as = async (actor: string, fn: (c: any) => Promise<any>) => {
    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL ROLE ${actor === 'anon' ? 'anon' : 'authenticated'}`);
      const sub = ids[actor] ?? '';
      await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [sub, JSON.stringify(sub ? { sub, role: 'authenticated' } : { role: 'anon' })]);
      const out = await fn(c); await c.query('COMMIT'); return out;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
  };
  return {
    async call(actor: string, fn: string, args: Record<string, unknown>) {
      const names = Object.keys(args); const vals = names.map((n) => args[n]);
      try {
        const r = await as(actor, (cl) => cl.query(`SELECT * FROM public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`, vals));
        const data = r.fields.length === 1 && r.fields[0].name === fn ? r.rows[0][fn] : r.rows;
        return { data, error: null };
      } catch (e: any) { return { data: null, error: { code: e.code, message: e.message } }; }
    },
    async items(actor: string) {
      try { return (await as(actor, (cl) => cl.query(`SELECT id, name FROM public.central_items WHERE name LIKE 'R1-ACCEPTANCE TEST%' ORDER BY name`))).rows; } catch { return []; }
    },
  };
}

const ENVV = { PHOENIX_STAGING_PUBLISHABLE_KEY: 'sb_publishable_SECRETKEY', PHOENIX_ACC_MAKER_EMAIL: 'maker@acc.rig', PHOENIX_ACC_MAKER_PASSWORD: 'MakerPw!1', PHOENIX_ACC_CHECKER_EMAIL: 'checker@acc.rig', PHOENIX_ACC_CHECKER_PASSWORD: 'CheckerPw!1' };
describe('functional-acceptance runner - refusals and secret hygiene (no network)', () => {
  const O = '00000000-0000-0000-0000-0000000c9601', B = '00000000-0000-0000-0000-0000000c9602';
  const capture = () => { const lines: string[] = []; return { lines, out: { log: (m: string) => lines.push(String(m)), error: (m: string) => lines.push(String(m)) } as any }; };
  const base = ['--org', O, '--beneficiary', B, '--plan-year', '2027'];
  it('its phrase is its own (names the cluster and the organization) and every refusal happens before any sign-in', async () => {
    expect(hostedConfirmationS3C(O)).toBe(`S3C-ACCEPT-knndhlczdlparjfmlxis-7692131729119822239-${O}`);
    expect(hostedConfirmationS3C(O)).not.toBe(hostedConfirmationS3P(O));
    let made = 0; const deps = { makeTransport: async () => { made += 1; return {} as any; } };
    for (const args of [[], base, [...base, '--confirm', hostedConfirmationS3P(O)], [...base, '--confirm', hostedConfirmationS3C(B)], ['--org', O, '--beneficiary', O, '--plan-year', '2027', '--confirm', hostedConfirmationS3C(O)], ['--org', O, '--beneficiary', B, '--plan-year', 'x', '--confirm', hostedConfirmationS3C(O)]]) {
      const { lines, out } = capture();
      expect(await acceptanceMain(args, ENVV, out, deps), JSON.stringify(args)).not.toBe(0);
      expect(lines.join('\n')).not.toMatch(/SECRETKEY|MakerPw|CheckerPw|maker@acc|checker@acc/);
    }
    for (const miss of Object.keys(ENVV)) { const e: any = { ...ENVV }; delete e[miss]; const { out } = capture(); expect(await acceptanceMain([...base, '--confirm', hostedConfirmationS3C(O)], e, out, deps), miss).toBe(1); }
    const { out } = capture(); expect(await acceptanceMain([...base, '--confirm', hostedConfirmationS3C(O)], { ...ENVV, PHOENIX_ACC_CHECKER_EMAIL: 'MAKER@acc.rig' }, out, deps)).toBe(1);   // one person twice
    expect(made).toBe(0);
  });
  it('the Staging transport talks only to the pinned project, keeps no session, and a sign-in failure never echoes a secret', async () => {
    const seen: any[] = [];
    const createClient = (url: string, key: string, opts: any) => { seen.push({ url, persist: opts.auth.persistSession, refresh: opts.auth.autoRefreshToken });
      return { auth: { signInWithPassword: async ({ password }: any) => ({ error: password === 'MakerPw!1' ? null : { status: 400, message: `bad ${password} for checker@acc.rig` } }), signOut: async () => ({}) }, rpc: async () => ({ data: null, error: null }) }; };
    await expect(stagingTransport(ENVV, { createClient })).rejects.toThrow(/sign-in as the checker account failed \(400\)$/);
    expect(seen.every((x) => x.url === `https://${PINNED.stagingRef}.supabase.co` && x.persist === false && x.refresh === false)).toBe(true);
    const { lines, out } = capture();
    await acceptanceMain([...base, '--confirm', hostedConfirmationS3C(O)], ENVV, out, { makeTransport: async () => { throw new Error('boom MakerPw!1 sb_publishable_SECRETKEY maker@acc.rig'); } });
    expect(lines.join('\n')).not.toMatch(/SECRETKEY|MakerPw|maker@acc/);
  });
});

const run = rigAvailable() && has221() ? describe : describe.skip;
run('R1 functional-acceptance journey on a provisioned + activated disposable database', { timeout: 900_000 }, () => {
  let c: any; let exec: any; let result: any; const lines: string[] = [];
  beforeAll(async () => {
    c = await freshRigDb({}); await c.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [BOOT_ID, OWNER_EMAIL]);
    exec = new PgExecutor(c, { kind: 'disposable-test', ref: 'disposable-local' });
    await runBaseline(exec, base({ mode: 'apply', authorization: A('S1', 'baseline-M001-M221'), evidenceSha256: EVID,
      bootstrap: { phase: 'S1-BOOTSTRAP', projectRef: 'disposable-local', authUserId: BOOT_ID, email: OWNER_EMAIL, ownerRef: T, attestedOn: '2026-10-19' },
      p5: { ownerRef: T, attestedOn: '2026-10-19', projectRef: 'disposable-local', evidenceSha256: EVID }, testHook: async (f: string, e: any) => { if (f.startsWith('001_')) await e.query(SUPA); } }));
    await runBaseline(exec, base({ mode: 'apply-candidates', candidates: true, authorization: A('S2', 'candidates-R1a_01-06') }));
    await runBaseline(exec, base({ mode: 'apply-r1b', candidates: true, r1b: true, authorization: A('S3', 'candidates-R1b_01-02') }));
    await c.query(`INSERT INTO auth.users (id, email) VALUES ($1,'maker@acc.rig'),($2,'checker@acc.rig')`, [MK, CK]);
    await runBaseline(exec, base({ mode: 'provision-org', candidates: true, r1b: true, organizationId: ORG, authorization: A('S3P', 'provision-test-org', { organizationId: ORG, beneficiaryOrganizationId: BEN, makerEmail: 'maker@acc.rig', checkerEmail: 'checker@acc.rig' }) }));
    await runBaseline(exec, base({ mode: 'activate-org', candidates: true, r1b: true, organizationId: ORG, authorization: A('S3B', 'activate-manual-cutover', { organizationId: ORG }) }));
    result = await runJourney(localTransport(c, { anon: null, maker: MK, checker: CK }), { orgId: ORG, beneficiaryId: BEN, planYear: 2027, log: (m: string) => lines.push(m) });
  }, 800_000);
  afterAll(async () => { await c?.end().catch(() => undefined); });

  it('every step of the journey passes (and the report carries no credential)', () => {
    if (process.env.JOURNEY_VERBOSE) console.log(lines.join('\n'));
    const failed = result.steps.filter((s: any) => !s.ok).map((s: any) => `${s.id}: ${s.detail}`);
    expect(failed, lines.join('\n')).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(24);
    expect(JSON.stringify(result)).not.toMatch(/@acc\.rig|password|secret/i);
  });
  it('the capability seal is still clean and exactly one organization is activated after the journey', async () => {
    expect((await c.query(`SELECT count(*)::int n FROM phoenix_private.central_needs_capability_breaches_v1()`)).rows[0].n).toBe(0);
    expect((await c.query(`SELECT count(*)::int n FROM central_needs_cutover_inventory WHERE entry_kind='activation_marker'`)).rows[0].n).toBe(1);
  });
  it('the CLI runner drives the same journey end to end through an injected transport: exit 0, PASS lines, no credential in the output', async () => {
    const lines: string[] = []; const out = { log: (m: string) => lines.push(String(m)), error: (m: string) => lines.push(String(m)) } as any;
    // a fresh plan year: the first journey already consumed 2027 in this database
    const code = await acceptanceMain(['--org', ORG, '--beneficiary', BEN, '--plan-year', '2029', '--confirm', hostedConfirmationS3C(ORG)], ENVV, out, { makeTransport: async () => localTransport(c, { anon: null, maker: MK, checker: CK }) });
    expect(lines.at(-1)).toMatch(/^JOURNEY (PASS|FAIL) \(\d+\/\d+ steps\)$/);
    expect(code, lines.join('\n')).toBe(0);
    expect(lines.join('\n')).not.toMatch(/SECRETKEY|MakerPw|CheckerPw|maker@acc|checker@acc/);
  });
  it('a journey run against an UNactivated organization fails closed (the first write is refused, the rest is blocked)', async () => {
    const t = localTransport(c, { anon: null, maker: MK, checker: CK });
    const r = await runJourney(t, { orgId: BEN, beneficiaryId: ORG, planYear: 2028 });
    expect(r.pass).toBe(false);
    expect(r.steps.some((s: any) => !s.ok && /blocked by/.test(s.detail))).toBe(true);
  });
});
