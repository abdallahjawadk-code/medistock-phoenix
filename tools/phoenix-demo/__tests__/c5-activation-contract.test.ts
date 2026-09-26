/**
 * C5 ACTIVATION CONTRACT — refusal and decision matrix (C5 v1.9 §2 / §19 / §21,
 * Owner hardening H1-H13).
 *
 * Pure unit test over tools/phoenix-demo/c5-activation-contract.mjs and the SQL
 * text in c5-activation-sql.mjs — no database, no runner, no Production, no
 * network. Every refusal the activation runbook can make and every HOLD / WAIT
 * / PASS branch is exercised by scenario and asserted by its stable `code`, so
 * a later edit cannot quietly turn one decision into a weaker one. The runbook
 * CLI's own no-database guards (loopback target, evidence outside the
 * repository, sealed manifest) are exercised here too; its database behaviour
 * is proven by the loopback rehearsal
 * (supabase/migrations/__tests__/217-central-needs-c5-activation-rehearsal.dynamic.test.ts).
 *
 * Baseline throughout: Production shaped exactly as sealed after the M216
 * dispatch (172 three-digit + 44 timestamp rows, canonical 216 at
 * 20260924124100), this checkout carrying 1..217, executor pinned 216 -> 217.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { parse as parsePgConnectionString } from 'pg-connection-string';
import * as C from '../c5-activation-contract.mjs';
import * as Q from '../c5-activation-sql.mjs';
import { EvidenceStore, REPO_ROOT, main } from '../c5-activation-runbook.mjs';
import { canonicalStem } from '../production-migration-history.mjs';
import { assertProjectRefPinned } from '../production-migration-contract.mjs';
import { sanitizeRemoteConnectionString } from '../../pg-rig/remote-io.mjs';

const M217_SHA = 'c'.repeat(64);
const TARGET_VERSION = '20260926120000';
const OP = '00000000-0000-0000-0000-000000217e12';
const ORG = '00000000-0000-0000-0000-000000217e01';
const ORG2 = '00000000-0000-0000-0000-000000217e02';

/** Local catalogue 1..217 with the REAL filenames of 173, 214, 215, 216 and 217. */
const REAL_FILES: Record<number, string> = {
  173: '173_phoenix_database_security_surface_hardening.sql',
  214: '214_phoenix_central_needs_review_readiness_volatility.sql',
  215: '215_phoenix_central_needs_governed_correction_lifecycle.sql',
  216: C.SEALED_M216.filename,
  217: C.M217_FILENAME,
};
const local = (overrides: Record<number, Partial<{ filename: string; sha256: string; manualApplyOnly: boolean }>> = {}) =>
  Array.from({ length: 217 }, (_, i) => {
    const v = i + 1;
    return {
      version: v,
      filename: REAL_FILES[v] ?? `${String(v).padStart(3, '0')}_phoenix_step_${v}.sql`,
      sha256: v === 216 ? C.SEALED_M216.sha256 : v === 217 ? M217_SHA : String(v).padStart(64, '0'),
      manualApplyOnly: false,
      ...(overrides[v] ?? {}),
    };
  });

const synth = (canonical: number) => new Date(Date.UTC(2026, 7, 11) + (canonical - 174) * 43_200_000)
  .toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

/** Production through the SEALED 216 row (literal real rows for 173/214/215/216). */
function productionThrough216(overrides: Record<number, { version?: string; name?: string }> = {}) {
  const rows: { version: string; name: string }[] = [];
  for (let i = 1; i <= 172; i++) rows.push({ version: String(i).padStart(3, '0'), name: `legacy_${i}` });
  for (let c = 173; c <= 216; c++) {
    let row: { version: string; name: string };
    if (c === 173) row = { version: '20260810200846', name: 'phoenix_database_security_surface_hardening' };
    else if (c === 214) row = { version: '20260914111813', name: 'fix_central_needs_review_readiness_volatility' };
    else if (c === 215) row = { version: '20260922153813', name: '215_phoenix_central_needs_governed_correction_lifecycle' };
    else if (c === 216) row = { version: '20260924124100', name: '216_phoenix_central_needs_region_persistence' };
    else row = { version: synth(c), name: canonicalStem(`${String(c).padStart(3, '0')}_phoenix_step_${c}.sql`) };
    rows.push({ ...row, ...(overrides[c] ?? {}) });
  }
  return rows;
}

const executor = (o: Record<string, unknown> = {}) => ({
  migrationFilename: C.M217_FILENAME, migrationSha256: M217_SHA,
  expectedCurrentCeiling: '216', expectedNextCeiling: '217', remoteHistoryVersion: TARGET_VERSION, ...o,
});
const attestArgs = (o: Record<string, unknown> = {}) => ({
  remoteRows: productionThrough216(), localMigrations: local(), executor: executor(), ...o,
});

function expectRefusal(fn: () => unknown, code: string) {
  let thrown: unknown;
  try { fn(); } catch (e) { thrown = e; }
  expect(thrown, `expected refusal ${code}, got none`).toBeInstanceOf(C.C5ActivationRefusal);
  expect((thrown as C.C5ActivationRefusal & { code: string }).code).toBe(code);
  return thrown as C.C5ActivationRefusal & { code: string; historyCode?: string; hold?: boolean };
}
async function expectAsyncRefusal(p: Promise<unknown>, code: string) {
  let thrown: unknown;
  try { await p; } catch (e) { thrown = e; }
  expect(thrown, `expected refusal ${code}, got none`).toBeInstanceOf(C.C5ActivationRefusal);
  expect((thrown as { code: string }).code).toBe(code);
}

// ---- ACL fixtures -----------------------------------------------------------
const t = (fn: string, grantee: string, o: Partial<{ grantor: string; grantable: boolean; owner: string }> = {}) =>
  ({ fn, owner: o.owner ?? 'postgres', grantee, grantor: o.grantor ?? 'postgres', privilege: 'EXECUTE', grantable: o.grantable ?? false });
const ACL0 = [
  t(C.SUBMIT_SIGNATURE, 'postgres'), t(C.SUBMIT_SIGNATURE, 'authenticated'), t(C.SUBMIT_SIGNATURE, 'service_role'),
  t(C.APPROVE_SIGNATURE, 'postgres'), t(C.APPROVE_SIGNATURE, 'authenticated'), t(C.APPROVE_SIGNATURE, 'service_role'),
];
const FROZEN = [t(C.SUBMIT_SIGNATURE, 'postgres'), t(C.APPROVE_SIGNATURE, 'postgres')];
const REJECT_ACL = [t(C.REJECT_SIGNATURE, 'postgres'), t(C.REJECT_SIGNATURE, 'authenticated'), t(C.REJECT_SIGNATURE, 'service_role')];

const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

describe('target selection — loopback rehearsal by default, Production never without a separate authorization', () => {
  it('accepts a loopback rehearsal URL', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(C.assertActivationTarget({ rehearsalUrl: `postgresql://postgres@${host}:55452/r` }).kind).toBe('rehearsal');
    }
  });
  it('refuses a non-loopback rehearsal URL, a missing one, an unparseable one and one naming the pinned ref', () => {
    expectRefusal(() => C.assertActivationTarget({ rehearsalUrl: 'postgresql://u:p@db.example.com:5432/postgres' }), 'TARGET_NOT_LOOPBACK');
    expectRefusal(() => C.assertActivationTarget({ rehearsalUrl: `postgresql://postgres.${'eyrzxgfkvqybjdgyphap'}@127.0.0.1:5432/p` }), 'TARGET_NOT_LOOPBACK');
    expectRefusal(() => C.assertActivationTarget({}), 'CONNECTION_STRING_MISSING');
    expectRefusal(() => C.assertActivationTarget({ rehearsalUrl: 'not a url' }), 'CONNECTION_STRING_UNPARSEABLE');
    expectRefusal(() => C.assertActivationTarget({ target: 'staging', rehearsalUrl: 'postgresql://127.0.0.1/x' }), 'TARGET_UNKNOWN');
  });
  it('refuses Production without the exact authorization phrase, and with the wrong project ref', () => {
    const prod = 'postgresql://postgres.eyrzxgfkvqybjdgyphap:pw@aws-0.pooler.supabase.com:5432/postgres';
    expectRefusal(() => C.assertActivationTarget({ target: 'production', productionUrl: prod }), 'PRODUCTION_NOT_AUTHORIZED');
    expectRefusal(() => C.assertActivationTarget({ target: 'production', productionUrl: prod, authorization: 'yes' }), 'PRODUCTION_NOT_AUTHORIZED');
    expectRefusal(() => C.assertActivationTarget({
      target: 'production', productionUrl: 'postgresql://postgres.otherref:pw@aws-0.pooler.supabase.com:5432/postgres',
      authorization: C.PRODUCTION_AUTHORIZATION_PHRASE,
    }), 'PROJECT_REF_MISMATCH');
    expect(C.assertActivationTarget({ target: 'production', productionUrl: prod, authorization: C.PRODUCTION_AUTHORIZATION_PHRASE }).kind)
      .toBe('production');
  });
  it('never echoes the connection string in a refusal', () => {
    const e = expectRefusal(() => C.assertActivationTarget({ rehearsalUrl: 'postgresql://u:SECRETPW@db.example.com/x' }), 'TARGET_NOT_LOOPBACK');
    expect(e.message).not.toContain('SECRETPW');
    expect(e.message).not.toContain('db.example.com');
  });
  it('D-06: refuses a loopback URL whose query overrides the host, hostaddr, port or service, whatever the case of the key', () => {
    for (const q of ['host=db.example.com', 'hostaddr=10.0.0.5', 'port=6543', 'HOST=db.example.com', 'Port=5433', 'service=prod', 'host=%2Ftmp']) {
      const e = expectRefusal(() => C.assertActivationTarget({ rehearsalUrl: `postgresql://postgres:SECRETPW@127.0.0.1:55452/r?${q}` }), 'TARGET_NOT_LOOPBACK');
      expect(e.message).not.toContain('SECRETPW');
      expect(e.message).not.toContain('db.example.com');
      expect(e.message).not.toContain('10.0.0.5');
    }
    // an innocuous query parameter is still accepted; the EFFECTIVE (driver-parsed) host is loopback
    expect(C.assertActivationTarget({ rehearsalUrl: 'postgresql://postgres@127.0.0.1:55452/r?application_name=c5' }).kind).toBe('rehearsal');
    expectRefusal(() => C.assertActivationTarget({ rehearsalUrl: 'mysql://root@127.0.0.1:3306/r' }), 'TARGET_NOT_LOOPBACK');
    expectRefusal(() => C.assertActivationTarget({ rehearsalUrl: 'postgresql:///r' }), 'TARGET_NOT_LOOPBACK');
    expectRefusal(() => C.assertActivationTarget({ rehearsalUrl: 'postgresql://127.0.0.1,db.example.com/r' }), 'TARGET_NOT_LOOPBACK');
    expect(C.CONNECTION_TARGET_REDIRECT_KEYS).toEqual(['host', 'hostaddr', 'port', 'service', 'servicefile']);
    expect(Object.isFrozen(C.CONNECTION_TARGET_REDIRECT_KEYS)).toBe(true);
  });
});

// ============================================================================
// DIR-01 — the Production branch binds the DRIVER's effective target to the
// pinned project, before any connection. Every refusal below is decided by the
// pure guard; the CLI case proves the same refusal precedes any connection.
// ============================================================================
describe('DIR-01 — Production effective-target binding (refused before any connection)', () => {
  const REF = 'eyrzxgfkvqybjdgyphap';
  const POOLER = `postgresql://postgres.${REF}:SECRETPW@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`;
  const DIRECT = `postgresql://postgres:SECRETPW@db.${REF}.supabase.co:5432/postgres`;
  /** Hermetic by default: an empty driver environment (the PG* fallbacks are tested explicitly below). */
  const prod = (productionUrl: string, driverEnv: Record<string, string> = {}) =>
    C.assertActivationTarget({ target: 'production', productionUrl, authorization: C.PRODUCTION_AUTHORIZATION_PHRASE, driverEnv });
  /** What node-postgres itself would dial for a connection string buildRemoteIo was given (no connection is made). */
  const driverTarget = (cs: string) => {
    const p = new pg.Client({ connectionString: sanitizeRemoteConnectionString(cs) }).connectionParameters;
    return { host: p.host, port: p.port, user: p.user, database: p.database };
  };
  const SECRET_FRAGMENTS = ['SECRETPW', '127.0.0.1', 'another.example', '10.0.0.5', 'otherref', 'evil', 'pooler.supabase.com', 'supabase.co',
    '/tmp/', '6000', '5433', 'otherdb', 'reference=', 'search_path', 'walsender-db'];
  /** The message AND every enumerable property of the refusal (what JSON / ::error:: output could carry). */
  const expectNoSecret = (e: Error) => {
    const surfaces = [e.message, JSON.stringify(e), JSON.stringify(Object.fromEntries(Object.entries(e)))];
    for (const surface of surfaces) for (const s of SECRET_FRAGMENTS) expect(surface, s).not.toContain(s);
  };

  it('the defect is real: without DIR-01 the only Production check (assertProjectRefPinned) accepts these, and the driver would dial elsewhere', () => {
    for (const [q, expected] of [
      ['host=127.0.0.1', { host: '127.0.0.1' }],
      ['host=another.example', { host: 'another.example' }],
      ['port=6000', { port: 6000 }],
      ['user=postgres.otherref', { user: 'postgres.otherref' }],
    ] as const) {
      const cs = `${POOLER}?${q}`;
      expect(assertProjectRefPinned(cs, REF)).toBe(REF); // the pre-DIR-01 gate passes
      expect(driverTarget(cs)).toMatchObject(expected); // ...but pg would not go to the pinned project
      expectNoSecret(expectRefusal(() => prod(cs), 'PRODUCTION_TARGET_REDIRECT'));
    }
    // a lexical username carrying the ref, on a foreign host: accepted before DIR-01, never the pinned project
    const foreign = `postgresql://postgres.${REF}:SECRETPW@another.example:5432/postgres`;
    expect(assertProjectRefPinned(foreign, REF)).toBe(REF);
    expectNoSecret(expectRefusal(() => prod(foreign), 'PRODUCTION_TARGET_NOT_PINNED'));
    const lookalike = `postgresql://postgres:SECRETPW@db.${REF}.supabase.co.another.example:5432/postgres`;
    expect(assertProjectRefPinned(lookalike, REF)).toBe(REF);
    expectNoSecret(expectRefusal(() => prod(lookalike), 'PRODUCTION_TARGET_NOT_PINNED'));
  });

  it('refuses every redirect-capable query key, whatever its case or encoding, on the pooler and the direct form — naming the key, never a value', () => {
    const queries = [
      'host=127.0.0.1', 'host=another.example', 'HOST=another.example', 'Host=127.0.0.1', 'h%6Fst=another.example',
      'host=another.example&host=another.example',
      'hostaddr=10.0.0.5', 'HostAddr=10.0.0.5', 'HOSTADDR=10.0.0.5',
      'port=6000', 'PORT=6543', 'Port=5433',
      'service=evil', 'SERVICE=evil', 'Service=evil',
      'servicefile=/tmp/pg_service.conf', 'ServiceFile=/tmp/pg_service.conf', 'SERVICEFILE=/tmp/x',
      'user=postgres.otherref', 'USER=postgres.otherref', 'options=reference%3Dotherref', 'Options=-c%20search_path%3Devil',
      'replication=walsender-db', 'REPLICATION=walsender-db',
      'sslmode=require&host=another.example', 'application_name=c5&hostaddr=10.0.0.5',
    ];
    for (const base of [POOLER, DIRECT]) {
      for (const q of queries) {
        const e = expectRefusal(() => prod(`${base}?${q}`), 'PRODUCTION_TARGET_REDIRECT');
        expectNoSecret(e);
        expect(e.message).toMatch(/\((?:host|hostaddr|port|service|servicefile|user|options|replication)(?:, [a-z]+)*\)/);
      }
    }
    expect(C.PRODUCTION_TENANT_ROUTING_KEYS).toEqual(['user', 'options']);
    expect(C.PRODUCTION_SESSION_MODE_KEYS).toEqual(['replication']);
  });

  it('refuses the PG* fallbacks pg would read for the refused startup options (PGOPTIONS, PGREPLICATION) — naming the variable, never its value', () => {
    // pg really does read them when the string carries none (prove it on the driver, without connecting)
    const saved = { PGOPTIONS: process.env.PGOPTIONS, PGREPLICATION: process.env.PGREPLICATION };
    try {
      process.env.PGOPTIONS = 'reference=otherref';
      process.env.PGREPLICATION = 'walsender-db';
      const startup = new pg.Client({ connectionString: sanitizeRemoteConnectionString(POOLER) }).getStartupConf();
      expect(startup).toMatchObject({ user: `postgres.${REF}`, options: 'reference=otherref', replication: 'walsender-db' });
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    for (const env of [{ PGOPTIONS: 'reference=otherref' }, { PGOPTIONS: '-c search_path=evil' }, { PGREPLICATION: 'walsender-db' }]) {
      for (const base of [POOLER, DIRECT]) {
        const e = expectRefusal(() => prod(base, env), 'PRODUCTION_TARGET_ENVIRONMENT');
        expectNoSecret(e);
        expect(e.message).toMatch(/\((?:PGOPTIONS|PGREPLICATION)\)/);
      }
    }
    // an empty value is no fallback; unrelated PG* variables are irrelevant (every target component is explicit)
    expect(prod(POOLER, { PGOPTIONS: '', PGHOST: '127.0.0.1', PGPORT: '1', PGUSER: 'x', PGDATABASE: 'y' }).kind).toBe('production');
    expect(C.PRODUCTION_DRIVER_ENV_KEYS).toEqual(['PGOPTIONS', 'PGREPLICATION']);
  });

  it('refuses a wrong protocol and an unparseable string', () => {
    for (const p of ['mysql', 'http', 'https', 'socket', 'postgresx']) {
      const e = expectRefusal(() => prod(`${p}://postgres.${REF}:SECRETPW@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`), 'PRODUCTION_TARGET_PROTOCOL');
      expectNoSecret(e);
    }
    // an opaque jdbc: URL carries no parseable username/host at all: the lexical ref gate already refuses it
    let thrown: unknown;
    try { prod(`jdbc:postgresql://postgres.${REF}:SECRETPW@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`); } catch (e) { thrown = e; }
    expect(['PROJECT_REF_MISMATCH', 'PRODUCTION_TARGET_PROTOCOL']).toContain((thrown as { code?: string })?.code);
    expectNoSecret(thrown as Error);
    // a password the DRIVER cannot decode (an invalid UTF-8 escape): its own URIError never surfaces
    const undecodable = `postgresql://postgres.${REF}:SECRET%E0%A4PW@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`;
    expect(() => parsePgConnectionString(sanitizeRemoteConnectionString(undecodable))).toThrow();
    const e = expectRefusal(() => prod(undecodable), 'PRODUCTION_TARGET_UNPARSEABLE');
    expectNoSecret(e);
    expect(e.message).not.toContain('%E0');
  });

  it('parses with the very parser pg uses (one pg-connection-string, not a look-alike copy)', () => {
    const fromPg = createRequire(createRequire(import.meta.url).resolve('pg'))('pg-connection-string').parse;
    expect(fromPg).toBe(parsePgConnectionString);
  });

  it('refuses an effective host or tenant outside the pinned project, and a port or database outside the Supabase shape', () => {
    for (const cs of [
      `postgresql://postgres.${REF}:SECRETPW@127.0.0.1:5432/postgres`,
      `postgresql://postgres.${REF}:SECRETPW@10.0.0.5:5432/postgres`,
      `postgresql://postgres.${REF}:SECRETPW@pooler.supabase.com.another.example:5432/postgres`,
      `postgresql://postgres.x.${REF}:SECRETPW@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`,
      `postgresql://postgres.otherref.${REF}:SECRETPW@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`,
      `postgresql://postgres.${REF}:SECRETPW@db.otherref.supabase.co:5432/postgres`,
    ]) expectNoSecret(expectRefusal(() => prod(cs), 'PRODUCTION_TARGET_NOT_PINNED'));
    for (const cs of [
      POOLER.replace(':5432/', '/'), // no port: pg would take PGPORT or 5432 from the environment
      POOLER.replace(':5432/', ':5433/'),
      DIRECT.replace(':5432/', ':6000/'),
      POOLER.replace(/\/postgres$/, '/otherdb'),
      POOLER.replace(/\/postgres$/, ''),
    ]) expectNoSecret(expectRefusal(() => prod(cs), 'PRODUCTION_TARGET_SHAPE'));
  });

  it('accepts the pinned pooler and direct forms, unchanged, with benign SSL / application parameters — and the driver would dial exactly the pinned endpoint', () => {
    for (const cs of [
      POOLER, DIRECT, POOLER.replace(':5432/', ':6543/'),
      `${POOLER}?sslmode=require`, `${DIRECT}?sslmode=require`,
      `${DIRECT}?sslmode=verify-full&sslrootcert=/nonexistent/ca.pem`, // stripped before pg reads it; never opened
      `${POOLER}?application_name=c5-activation&connect_timeout=10`,
      `${POOLER}?sslmode=require&application_name=c5-activation&statement_timeout=60000`,
    ]) {
      const out = prod(cs);
      expect(out).toEqual({ kind: 'production', connectionString: cs });
      const d = driverTarget(cs);
      expect([`db.${REF}.supabase.co`, 'aws-0-eu-central-1.pooler.supabase.com']).toContain(d.host);
      expect([5432, 6543]).toContain(d.port);
      expect(d.database).toBe('postgres');
      expect(d.user === 'postgres' || d.user === `postgres.${REF}`).toBe(true);
    }
  });

  it('keeps the existing gates first: the authorization phrase, then the lexical project ref', () => {
    expectRefusal(() => C.assertActivationTarget({ target: 'production', productionUrl: `${POOLER}?host=127.0.0.1` }), 'PRODUCTION_NOT_AUTHORIZED');
    expectRefusal(() => prod('postgresql://postgres.otherref:SECRETPW@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?host=127.0.0.1'),
      'PROJECT_REF_MISMATCH');
  });

  it('through the CLI: a redirecting Production URL is refused BEFORE any connection attempt (a local listener counts every attempt)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c5-dir01-'));
    scratch.push(dir);
    // Every refused URL below points the DRIVER at this loopback listener (never at the real pooler), so a
    // regression that connected before refusing would be counted here instead of reaching Production.
    let attempts = 0;
    const listener = createServer((socket) => { attempts += 1; socket.destroy(); });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    try {
      // control: the listener does count a real connection attempt
      await new Promise<void>((resolve, reject) => {
        const s = new pg.Client({ connectionString: `postgresql://probe@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
        s.connect().then(() => reject(new Error('unexpected connect')), () => resolve());
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(attempts).toBe(1);
      const redirect = `host=127.0.0.1&port=${port}`;
      for (const q of [redirect, `${redirect}&HostAddr=127.0.0.1`, `${redirect}&user=postgres.otherref`, `${redirect}&service=evil`,
        `${redirect}&replication=walsender-db`, `${redirect}&Options=-c%20search_path%3Devil`]) {
        await expectAsyncRefusal(main(['--phase=preflight', `--evidence-dir=${dir}`, '--target=production'], {
          PHOENIX_PRODUCTION_DATABASE_URL: `${POOLER}?${q}`,
          PHOENIX_C5_ACTIVATION_AUTHORIZATION: C.PRODUCTION_AUTHORIZATION_PHRASE,
        }), 'PRODUCTION_TARGET_REDIRECT');
      }
      await expectAsyncRefusal(main(['--phase=preflight', `--evidence-dir=${dir}`, '--target=production'], {
        PHOENIX_PRODUCTION_DATABASE_URL: `postgresql://postgres.${REF}:SECRETPW@127.0.0.1:${port}/postgres`,
        PHOENIX_C5_ACTIVATION_AUTHORIZATION: C.PRODUCTION_AUTHORIZATION_PHRASE,
      }), 'PRODUCTION_TARGET_NOT_PINNED');
      await new Promise((r) => setTimeout(r, 100));
      expect(attempts).toBe(1); // only the control: the CLI refused every one of them before connecting
    } finally {
      await new Promise((r) => listener.close(r));
    }
  });

  it('never prints a misplaced connection string: an unknown --target or an unrecognized argument is refused without echoing it', async () => {
    const e = expectRefusal(() => C.assertActivationTarget({ target: POOLER }), 'TARGET_UNKNOWN');
    expectNoSecret(e);
    let thrown: unknown;
    try { await main([POOLER], {}); } catch (err) { thrown = err; }
    expect((thrown as { code?: string })?.code).toBe('ARGUMENT_UNRECOGNIZED');
    expectNoSecret(thrown as Error);
  });
});

describe('D-11 / D-02 — explicit Owner cascade reference and the executor terminal state', () => {
  it('the reviewed CASCADE path needs an Owner review reference; a bare flag, an empty or multi-line value is refused', () => {
    expect(C.assertReviewedCascade(undefined)).toBeNull();
    expect(C.assertReviewedCascade(null)).toBeNull();
    expect(C.assertReviewedCascade(false)).toBeNull();
    expect(C.assertReviewedCascade('  OWNER-CASCADE-REVIEW-7 ')).toEqual({ owner_reference: 'OWNER-CASCADE-REVIEW-7' });
    expectRefusal(() => C.assertReviewedCascade(true), 'CASCADE_OWNER_REFERENCE_REQUIRED');
    expectRefusal(() => C.assertReviewedCascade('   '), 'CASCADE_OWNER_REFERENCE_REQUIRED');
    expectRefusal(() => C.assertReviewedCascade('a\nb'), 'CASCADE_OWNER_REFERENCE_REQUIRED');
    expectRefusal(() => C.assertReviewedCascade('x'.repeat(201)), 'CASCADE_OWNER_REFERENCE_REQUIRED');
    expectRefusal(() => C.assertReviewedCascade('postgresql://u:p@h/db'), 'CASCADE_OWNER_REFERENCE_REQUIRED');
  });
  it('the executor terminal state is a known conclusion with a numeric run id — or not_dispatched with none', () => {
    expect(C.assertExecutorRun(undefined)).toBeNull();
    expect(C.assertExecutorRun({ run_id: '36026915933', conclusion: 'failure' })).toEqual({ run_id: '36026915933', conclusion: 'failure' });
    expect(C.assertExecutorRun({ run_id: 36026915933, conclusion: 'cancelled' })).toEqual({ run_id: '36026915933', conclusion: 'cancelled' });
    expect(C.assertExecutorRun({ conclusion: 'not_dispatched' })).toEqual({ run_id: null, conclusion: 'not_dispatched' });
    expect(C.assertExecutorRun({ run_id: 'none', conclusion: 'not_dispatched' })).toEqual({ run_id: null, conclusion: 'not_dispatched' });
    expectRefusal(() => C.assertExecutorRun({ run_id: '1', conclusion: 'skipped' }), 'EXECUTOR_RUN_MALFORMED');
    expectRefusal(() => C.assertExecutorRun({ conclusion: 'failure' }), 'EXECUTOR_RUN_MALFORMED');
    expectRefusal(() => C.assertExecutorRun({ run_id: 'abc', conclusion: 'failure' }), 'EXECUTOR_RUN_MALFORMED');
    expectRefusal(() => C.assertExecutorRun({ run_id: '12', conclusion: 'not_dispatched' }), 'EXECUTOR_RUN_MALFORMED');
    expect(C.EXECUTOR_NON_COMMIT_CONCLUSIONS).not.toContain('success');
  });
});

describe('evidence directory and operator identity', () => {
  it('refuses evidence inside the repository and a missing directory', () => {
    expectRefusal(() => C.assertEvidenceDirOutsideRepo(join(REPO_ROOT, 'tmp-evidence'), REPO_ROOT), 'EVIDENCE_DIR_INSIDE_REPO');
    expectRefusal(() => C.assertEvidenceDirOutsideRepo(REPO_ROOT, REPO_ROOT), 'EVIDENCE_DIR_INSIDE_REPO');
    expectRefusal(() => C.assertEvidenceDirOutsideRepo('', REPO_ROOT), 'EVIDENCE_DIR_MISSING');
    expect(C.assertEvidenceDirOutsideRepo(join(tmpdir(), 'c5-evidence'), REPO_ROOT)).toBe(join(tmpdir(), 'c5-evidence'));
  });
  it('requires the operator to be named by profile uuid', () => {
    expect(C.assertOperatorId(OP.toUpperCase())).toBe(OP);
    expectRefusal(() => C.assertOperatorId('operator'), 'OPERATOR_ID_MALFORMED');
    expectRefusal(() => C.assertOperatorId(undefined), 'OPERATOR_ID_MALFORMED');
  });
});

describe('H12 — fresh Production-history attestation before T0', () => {
  it('PASSES the sealed shape and binds the fresh 216 row, the sealed SHA-256 and the executor inputs', () => {
    const a = C.attestProductionHistory(attestArgs());
    expect(a).toMatchObject({
      canonical_ceiling: 216, remote_row_count: 216, numeric_row_count: 172, timestamp_row_count: 44,
      m216: { fresh_version: '20260924124100', fresh_name: '216_phoenix_central_needs_region_persistence', sealed_sha256: C.SEALED_M216.sha256 },
      m217: { filename: C.M217_FILENAME, executor_sha256: M217_SHA, remote_history_version: TARGET_VERSION, expected_history_name: C.M217_HISTORY_NAME },
      newest_remote_version: '20260924124100',
    });
  });
  it('the sealed M216 identity is the dispatch record, not the pre-dispatch fixture', () => {
    expect(C.SEALED_M216).toEqual({
      canonical: 216, filename: '216_phoenix_central_needs_region_persistence.sql',
      sha256: '6084eabbe2113e20cd8d25c5e5dd8c4ba9023117044f02ac012b014ab2d88052',
      remoteVersion: '20260924124100', remoteName: '216_phoenix_central_needs_region_persistence',
    });
    expect(Object.isFrozen(C.SEALED_M216)).toBe(true);
    // A history carrying the pre-dispatch fixture timestamp at 216 is NOT Production truth.
    expectRefusal(() => C.attestProductionHistory(attestArgs({ remoteRows: productionThrough216({ 216: { version: '20260923215400' } }) })),
      'M216_ROW_VERSION_MISMATCH');
  });
  it('validates every executor input before T0', () => {
    expectRefusal(() => C.attestProductionHistory(attestArgs({ executor: executor({ expectedCurrentCeiling: '215' }) })), 'EXECUTOR_CEILING_MISMATCH');
    expectRefusal(() => C.attestProductionHistory(attestArgs({ executor: executor({ expectedNextCeiling: '218' }) })), 'EXECUTOR_CEILING_MISMATCH');
    expectRefusal(() => C.attestProductionHistory(attestArgs({ executor: executor({ migrationFilename: '217_other.sql' }) })), 'EXECUTOR_FILENAME_MISMATCH');
    expectRefusal(() => C.attestProductionHistory(attestArgs({ executor: executor({ migrationSha256: 'C'.repeat(64) }) })), 'EXECUTOR_SHA256_MALFORMED');
    expectRefusal(() => C.attestProductionHistory(attestArgs({ executor: executor({ migrationSha256: 'd'.repeat(64) }) })), 'EXECUTOR_SHA256_MISMATCH');
    let e = expectRefusal(() => C.attestProductionHistory(attestArgs({ executor: executor({ remoteHistoryVersion: '20260924124100' }) })),
      'REMOTE_HISTORY_VERSION_UNUSABLE');
    expect(e.historyCode).toBe('TARGET_VERSION_ALREADY_PRESENT');
    e = expectRefusal(() => C.attestProductionHistory(attestArgs({ executor: executor({ remoteHistoryVersion: '20260924124059' }) })),
      'REMOTE_HISTORY_VERSION_UNUSABLE');
    expect(e.historyCode).toBe('TARGET_VERSION_NOT_NEWEST');
    e = expectRefusal(() => C.attestProductionHistory(attestArgs({ executor: executor({ remoteHistoryVersion: '2026092612' }) })),
      'REMOTE_HISTORY_VERSION_UNUSABLE');
    expect(e.historyCode).toBe('TARGET_VERSION_SHAPE');
  });
  it('binds the local catalogue: sealed 216 bytes, exactly one canonical 217, no MANUAL APPLY ONLY banner', () => {
    expectRefusal(() => C.attestProductionHistory(attestArgs({ localMigrations: [] })), 'LOCAL_MANIFEST_EMPTY');
    expectRefusal(() => C.attestProductionHistory(attestArgs({ localMigrations: local({ 216: { sha256: 'e'.repeat(64) } }) })), 'M216_LOCAL_SHA256_MISMATCH');
    expectRefusal(() => C.attestProductionHistory(attestArgs({ localMigrations: local({ 216: { filename: '216_renamed.sql' } }) })), 'M216_LOCAL_FILENAME_MISMATCH');
    expectRefusal(() => C.attestProductionHistory(attestArgs({ localMigrations: local().filter((m) => m.version !== 217) })), 'M217_MISSING_LOCALLY');
    expectRefusal(() => C.attestProductionHistory(attestArgs({ localMigrations: local({ 217: { filename: '217_other_name.sql' } }) })), 'M217_MISSING_LOCALLY');
    expectRefusal(() => C.attestProductionHistory(attestArgs({ localMigrations: local({ 217: { manualApplyOnly: true } }) })), 'M217_MANUAL_APPLY_ONLY');
  });
  it('reconciles the FRESH history and refuses anything but a clean ceiling 216', () => {
    let e = expectRefusal(() => C.attestProductionHistory(attestArgs({ remoteRows: productionThrough216({ 214: { name: '214_phoenix_central_needs_review_readiness_volatility' } }) })),
      'HISTORY_NOT_RECONCILED');
    expect(e.historyCode).toBe('REMOTE_NAME_MISMATCH');
    e = expectRefusal(() => C.attestProductionHistory(attestArgs({ remoteRows: [] })), 'HISTORY_NOT_RECONCILED');
    expect(e.historyCode).toBe('REMOTE_HISTORY_EMPTY');
    expectRefusal(() => C.attestProductionHistory(attestArgs({ remoteRows: productionThrough216().slice(0, 215) })), 'CEILING_NOT_216');
    expectRefusal(() => C.attestProductionHistory(attestArgs({
      remoteRows: [...productionThrough216(), { version: TARGET_VERSION, name: C.M217_HISTORY_NAME }],
    })), 'M217_ALREADY_RECORDED');
    expectRefusal(() => C.attestProductionHistory(attestArgs({ sealedM216: { ...C.SEALED_M216, remoteName: 'phoenix_central_needs_region_persistence' } })),
      'M216_ROW_NAME_MISMATCH');
  });
});

describe('D-05 — the preflight is re-attested immediately before T0 and has a bounded age', () => {
  const at = '2026-09-26T10:00:00.000000Z';
  it('PASSES a fresh preflight (database clock) and returns its age', () => {
    expect(C.assertPreflightFresh({ preflightAt: at, now: '2026-09-26T10:05:00.500000Z' })).toBeCloseTo(300.5, 3);
    expect(C.PREFLIGHT_MAX_AGE_SECONDS).toBe(900);
  });
  it('refuses a stale, missing or clock-regressed preflight; a caller may tighten the bound but never widen it', () => {
    expectRefusal(() => C.assertPreflightFresh({ preflightAt: at, now: '2026-09-26T10:15:00.002000Z' }), 'PREFLIGHT_STALE');
    expectRefusal(() => C.assertPreflightFresh({ preflightAt: at, now: '2026-09-26T10:30:00.000000Z', maxAgeSeconds: 3600 }), 'PREFLIGHT_STALE');
    expectRefusal(() => C.assertPreflightFresh({ preflightAt: at, now: '2026-09-26T10:00:02.000000Z', maxAgeSeconds: 1 }), 'PREFLIGHT_STALE');
    expectRefusal(() => C.assertPreflightFresh({ preflightAt: undefined, now: at }), 'PREFLIGHT_TIME_MISSING');
    expectRefusal(() => C.assertPreflightFresh({ preflightAt: at, now: 'garbage' }), 'PREFLIGHT_TIME_MISSING');
    expectRefusal(() => C.assertPreflightFresh({ preflightAt: at, now: '2026-09-26T09:59:59.000000Z' }), 'PREFLIGHT_CLOCK_REGRESSED');
  });
  it('the history attestation re-read before T0 must be the sealed one exactly', () => {
    const sealed = C.attestProductionHistory(attestArgs());
    expect(C.assertAttestationUnchanged(JSON.parse(JSON.stringify(sealed)), C.attestProductionHistory(attestArgs()))).toBe(true);
    const moved = C.attestProductionHistory(attestArgs({ executor: executor({ remoteHistoryVersion: '20260926120001' }) }));
    expectRefusal(() => C.assertAttestationUnchanged(sealed, moved), 'PREFLIGHT_ATTESTATION_CHANGED');
    expectRefusal(() => C.assertAttestationUnchanged(sealed, { ...sealed, remote_row_count: sealed.remote_row_count + 1 }), 'PREFLIGHT_ATTESTATION_CHANGED');
    expectRefusal(() => C.assertAttestationUnchanged(undefined, sealed), 'PREFLIGHT_ATTESTATION_CHANGED');
  });
});

describe('H1 — runner capability and one identity for every read', () => {
  const base = { current_user: 'postgres', session_user: 'postgres', rolsuper: false, rolbypassrls: true, pg_read_all_stats: true };
  it('PASSES a superuser, and a BYPASSRLS pg_read_all_stats member', () => {
    expect(C.assertRunnerCapability({ ...base, rolsuper: true, rolbypassrls: false, pg_read_all_stats: false }).rolsuper).toBe(true);
    expect(C.assertRunnerCapability(base)).toMatchObject({ current_user: 'postgres', rolbypassrls: true, pg_read_all_stats: true });
  });
  it('refuses a runner that RLS would filter, or that cannot see every session', () => {
    expectRefusal(() => C.assertRunnerCapability({ ...base, rolbypassrls: false }), 'RUNNER_CANNOT_BYPASS_RLS');
    expectRefusal(() => C.assertRunnerCapability({ ...base, pg_read_all_stats: false }), 'RUNNER_CANNOT_SEE_ALL_SESSIONS');
    expectRefusal(() => C.assertRunnerCapability(null), 'RUNNER_ATTRIBUTES_MISSING');
    expectRefusal(() => C.assertRunnerCapability({ ...base, pg_read_all_stats: 'yes' }), 'RUNNER_ATTRIBUTES_MISSING');
  });
  it('refuses a read by any other identity', () => {
    expect(C.assertSameRunner(base, { current_user: 'postgres' }, 'x')).toBe(true);
    expectRefusal(() => C.assertSameRunner(base, { current_user: 'service_role' }, 'drain'), 'RUNNER_IDENTITY_CHANGED');
    expectRefusal(() => C.assertSameRunner(base, { current_user: 'postgres', session_user: 'other' }, 'drain'), 'RUNNER_IDENTITY_CHANGED');
    expectRefusal(() => C.assertSameRunner(null, base, 'drain'), 'RUNNER_IDENTITY_CHANGED');
  });
});

describe('H7 — the governed rejection operator, before T0', () => {
  const operator = { id: OP, role: 'central_warehouse_manager', status: 'active', organization_id: ORG, has_reject_capability: true };
  const orgs = [{ id: ORG, exists: true, archived: false }];
  const ok = (o: Record<string, unknown> = {}) => ({ operator, ownerOrgs: orgs, rejectExecutableByAuthenticated: true, ...o });
  it('PASSES an eligible operator covering every owner organization; super_admin covers any', () => {
    expect(C.assertRejectOperatorReady(ok())).toMatchObject({ operator_id: OP, owner_orgs_checked: [ORG] });
    expect(C.assertRejectOperatorReady(ok({ operator: { ...operator, role: 'super_admin', organization_id: null },
      ownerOrgs: [...orgs, { id: ORG2, exists: true, archived: false }] })).owner_orgs_checked).toEqual([ORG, ORG2].sort());
  });
  it('refuses each missing capability', () => {
    expectRefusal(() => C.assertRejectOperatorReady(ok({ operator: null })), 'OPERATOR_NOT_FOUND');
    expectRefusal(() => C.assertRejectOperatorReady(ok({ operator: { ...operator, status: 'inactive' } })), 'OPERATOR_NOT_ACTIVE');
    expectRefusal(() => C.assertRejectOperatorReady(ok({ operator: { ...operator, role: 'institution_admin' } })), 'OPERATOR_ROLE_INELIGIBLE');
    expectRefusal(() => C.assertRejectOperatorReady(ok({ operator: { ...operator, has_reject_capability: false } })), 'OPERATOR_LACKS_REJECT_CAPABILITY');
    expectRefusal(() => C.assertRejectOperatorReady(ok({ ownerOrgs: [{ id: ORG, exists: true, archived: true }] })), 'OWNER_ORG_NOT_LIVE');
    expectRefusal(() => C.assertRejectOperatorReady(ok({ ownerOrgs: [{ id: ORG, exists: false, archived: false }] })), 'OWNER_ORG_NOT_LIVE');
    expectRefusal(() => C.assertRejectOperatorReady(ok({ ownerOrgs: [...orgs, { id: ORG2, exists: true, archived: false }] })), 'OPERATOR_ORG_MISMATCH');
    expectRefusal(() => C.assertRejectOperatorReady(ok({ rejectExecutableByAuthenticated: false })), 'REJECT_RPC_NOT_CALLABLE');
  });
});

describe('H8 — ACL tuples, semantic equality, freeze and restore plans', () => {
  it('compares ACL sets order- and duplicate-insensitively on (fn, owner, grantee, grantor, privilege, grantable)', () => {
    const shuffled = [ACL0[4], ACL0[1], ACL0[5], ACL0[0], ACL0[3], ACL0[2], ACL0[1]];
    expect(C.aclSetsEqual(ACL0, shuffled)).toBe(true);
    expect(C.aclSetsEqual(ACL0, ACL0.slice(1))).toBe(false);
    expect(C.aclSetsEqual(ACL0, ACL0.map((x) => (x.grantee === 'authenticated' ? { ...x, grantable: true } : x)))).toBe(false);
    expect(C.aclSetsEqual(ACL0, ACL0.map((x) => (x.grantee === 'service_role' ? { ...x, grantor: 'service_role' } : x)))).toBe(false);
    expect(C.aclSetsEqual(ACL0, ACL0.map((x) => ({ ...x, owner: 'supabase_admin' })))).toBe(false);
    expect(C.aclSetDifference(ACL0, FROZEN).map((x) => x.grantee).sort()).toEqual(['authenticated', 'authenticated', 'service_role', 'service_role']);
    expectRefusal(() => C.normalizeAclTuple({ fn: 'x' }), 'ACL_TUPLE_MALFORMED');
  });
  it('judges ACL0: incomplete / unexpected function, non-owner grantor and grant option are HOLDs unless the reviewed CASCADE path is chosen', () => {
    expect(C.assessAclSnapshot(ACL0)).toMatchObject({ tuple_count: 6, cascade: false });
    expect(expectRefusal(() => C.assessAclSnapshot(ACL0.filter((x) => x.fn === C.SUBMIT_SIGNATURE)), 'ACL_SNAPSHOT_INCOMPLETE').hold).toBe(true);
    expectRefusal(() => C.assessAclSnapshot([...ACL0, t(C.REJECT_SIGNATURE, 'authenticated')]), 'ACL_SNAPSHOT_INCOMPLETE');
    const chain = [...ACL0, t(C.SUBMIT_SIGNATURE, 'chain_a', { grantable: true }), t(C.SUBMIT_SIGNATURE, 'chain_b', { grantor: 'chain_a' })];
    expectRefusal(() => C.assessAclSnapshot(chain), 'ACL_NON_OWNER_GRANTOR');
    expectRefusal(() => C.assessAclSnapshot([...ACL0, t(C.SUBMIT_SIGNATURE, 'chain_a', { grantable: true })]), 'ACL_GRANT_OPTION_CHAIN');
    expect(C.assessAclSnapshot(chain, { reviewedCascade: true })).toMatchObject({ cascade: true });
  });
  it('plans the freeze: every captured non-owner grantee, then the explicit four; reject is never named; CASCADE only when reviewed', () => {
    const stmts = C.planFreezeStatements(ACL0);
    expect(stmts).toEqual([
      `REVOKE EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} FROM "authenticated"`,
      `REVOKE EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} FROM "service_role"`,
      `REVOKE EXECUTE ON FUNCTION ${C.APPROVE_SIGNATURE} FROM "authenticated"`,
      `REVOKE EXECUTE ON FUNCTION ${C.APPROVE_SIGNATURE} FROM "service_role"`,
      `REVOKE EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} FROM "authenticated", "service_role", "anon", PUBLIC`,
      `REVOKE EXECUTE ON FUNCTION ${C.APPROVE_SIGNATURE} FROM "authenticated", "service_role", "anon", PUBLIC`,
    ]);
    expect(stmts.join('\n')).not.toContain('reject_revision');
    expect(stmts.join('\n')).not.toMatch(/\bGRANT\b|CASCADE/);
    const withPublic = C.planFreezeStatements([...ACL0, t(C.SUBMIT_SIGNATURE, 'PUBLIC'), t(C.SUBMIT_SIGNATURE, 'custom_reader')]);
    expect(withPublic).toContain(`REVOKE EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} FROM PUBLIC`);
    expect(withPublic).toContain(`REVOKE EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} FROM "custom_reader"`);
    const chain = [...ACL0, t(C.SUBMIT_SIGNATURE, 'chain_a', { grantable: true }), t(C.SUBMIT_SIGNATURE, 'chain_b', { grantor: 'chain_a' })];
    expect(C.planFreezeStatements(chain)).not.toContain(`REVOKE EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} FROM "chain_a" CASCADE`);
    expect(C.planFreezeStatements(chain, { reviewedCascade: true })).toContain(`REVOKE EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} FROM "chain_a" CASCADE`);
    expectRefusal(() => C.planFreezeStatements([t(C.REJECT_SIGNATURE, 'authenticated')]), 'ACL_FUNCTION_UNEXPECTED');
  });
  it('plans the restore: exactly ACL0 (never a default grant), grant options kept, chain grants re-issued AS their grantor', () => {
    expect(C.planRestoreStatements(ACL0)).toEqual([
      `GRANT EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} TO "authenticated"`,
      `GRANT EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} TO "service_role"`,
      `GRANT EXECUTE ON FUNCTION ${C.APPROVE_SIGNATURE} TO "authenticated"`,
      `GRANT EXECUTE ON FUNCTION ${C.APPROVE_SIGNATURE} TO "service_role"`,
    ]);
    const chain = [...ACL0, t(C.SUBMIT_SIGNATURE, 'chain_b', { grantor: 'chain_a' }), t(C.SUBMIT_SIGNATURE, 'chain_a', { grantable: true })];
    const plan = C.planRestoreStatements(chain);
    expect(plan.slice(-3)).toEqual(['SET LOCAL ROLE "chain_a"', `GRANT EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} TO "chain_b"`, 'RESET ROLE']);
    expect(plan.indexOf(`GRANT EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} TO "chain_a" WITH GRANT OPTION`)).toBeLessThan(plan.indexOf('SET LOCAL ROLE "chain_a"'));
    expect(C.planRestoreStatements([...ACL0, t(C.SUBMIT_SIGNATURE, 'PUBLIC')])).toContain(`GRANT EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} TO PUBLIC`);
    expect(C.planRestoreStatements(FROZEN)).toEqual([]);
  });
  it('quotes role names and refuses anything that is not a plain identifier', () => {
    expect(C.quoteRole('PUBLIC')).toBe('PUBLIC');
    expect(C.quoteRole('service_role')).toBe('"service_role"');
    expectRefusal(() => C.quoteRole('x"; DROP TABLE y; --'), 'ACL_ROLE_NAME_UNSAFE');
    expectRefusal(() => C.quoteRole(''), 'ACL_ROLE_NAME_UNSAFE');
  });
  it('verifies the freeze: only owner tuples left, no client role executes, captured grantees cut off, reject untouched', () => {
    const priv = (fn: string, role: string, can: boolean, o: Record<string, boolean> = {}) => ({ fn, role, can_execute: can, superuser: false, owner_equivalent: false, ...o });
    const clean = [priv(C.SUBMIT_SIGNATURE, 'authenticated', false), priv(C.SUBMIT_SIGNATURE, 'service_role', false), priv(C.SUBMIT_SIGNATURE, 'anon', false)];
    expect(C.assessFreeze({ acl0: ACL0, frozenAcl: FROZEN, privileges: clean, rejectAcl0: REJECT_ACL, rejectAclNow: [...REJECT_ACL].reverse() }))
      .toMatchObject({ pass: true, failures: [] });
    const residue = C.assessFreeze({ acl0: ACL0, frozenAcl: [...FROZEN, t(C.SUBMIT_SIGNATURE, 'service_role')], privileges: clean, rejectAcl0: REJECT_ACL, rejectAclNow: REJECT_ACL });
    expect(residue.failures.map((f) => f.code)).toEqual(['ACL_FREEZE_INCOMPLETE']);
    const sr = C.assessFreeze({ acl0: ACL0, frozenAcl: FROZEN, privileges: [priv(C.APPROVE_SIGNATURE, 'service_role', true)], rejectAcl0: REJECT_ACL, rejectAclNow: REJECT_ACL });
    expect(sr.pass).toBe(false);
    const acl0x = [...ACL0, t(C.SUBMIT_SIGNATURE, 'custom_reader'), t(C.SUBMIT_SIGNATURE, 'supabase_admin')];
    const captured = C.assessFreeze({
      acl0: acl0x, frozenAcl: FROZEN, rejectAcl0: REJECT_ACL, rejectAclNow: REJECT_ACL,
      privileges: [priv(C.SUBMIT_SIGNATURE, 'custom_reader', true), priv(C.SUBMIT_SIGNATURE, 'supabase_admin', true, { superuser: true })],
    });
    expect(captured.failures).toEqual([{ code: 'ACL_FREEZE_INCOMPLETE', detail: `captured grantee custom_reader can still execute ${C.SUBMIT_SIGNATURE}` }]);
    expect(captured.owner_equivalent_grantees).toEqual([`${C.SUBMIT_SIGNATURE}:supabase_admin`]);
    const moved = C.assessFreeze({ acl0: ACL0, frozenAcl: FROZEN, privileges: clean, rejectAcl0: REJECT_ACL, rejectAclNow: REJECT_ACL.slice(1) });
    expect(moved.failures.map((f) => f.code)).toEqual(['REJECT_ACL_CHANGED']);
    // an owner tuple that went missing is not the planned frozen set
    const shape = C.assessFreeze({ acl0: ACL0, frozenAcl: FROZEN.slice(1), privileges: clean, rejectAcl0: REJECT_ACL, rejectAclNow: REJECT_ACL });
    expect(shape.failures.map((f) => f.code)).toEqual(['ACL_FREEZE_SHAPE_UNEXPECTED']);
  });
  it('D-03: the planned frozen set is exactly the owner tuples of ACL0', () => {
    expect(C.aclSetsEqual(C.planFrozenAcl(ACL0), FROZEN)).toBe(true);
    expect(C.planFrozenAcl([...ACL0, t(C.SUBMIT_SIGNATURE, 'PUBLIC'), t(C.SUBMIT_SIGNATURE, 'chain_a', { grantable: true })])).toHaveLength(2);
  });
  it('D-09: a genuine ACL0 lets authenticated (directly or through PUBLIC) execute BOTH submit and approve', () => {
    expect(C.aclGrantsClientExecute(ACL0)).toBe(true);
    expect(C.aclGrantsClientExecute(FROZEN)).toBe(false);
    expect(C.aclGrantsClientExecute([...FROZEN, t(C.SUBMIT_SIGNATURE, 'PUBLIC'), t(C.APPROVE_SIGNATURE, 'PUBLIC')])).toBe(true);
    expect(C.aclGrantsClientExecute([...FROZEN, t(C.SUBMIT_SIGNATURE, 'authenticated'), t(C.APPROVE_SIGNATURE, 'service_role')])).toBe(false);
  });
  it('D-03: the freeze state is derived from catalog truth — frozen set, ACL0, or UNKNOWN (never false by assumption)', () => {
    const derive = (liveAcl: unknown, o: Record<string, unknown> = {}) => C.deriveFreezeState({ liveAcl, acl0: ACL0, frozenAcl: FROZEN, ...o } as never);
    expect(derive([...FROZEN].reverse())).toMatchObject({ state: 'IN_PLACE', freeze_in_place: true });
    expect(derive([...ACL0].reverse())).toMatchObject({ state: 'NOT_IN_PLACE', freeze_in_place: false });
    const partial = derive([...FROZEN, t(C.APPROVE_SIGNATURE, 'service_role')]);
    expect(partial).toMatchObject({ state: 'UNKNOWN', freeze_in_place: 'UNKNOWN' });
    expect(partial.unexpected_vs_frozen).toEqual([t(C.APPROVE_SIGNATURE, 'service_role')]);
    expect(derive(null)).toMatchObject({ state: 'UNKNOWN', freeze_in_place: 'UNKNOWN' });
    expect(derive(FROZEN, { acl0: null })).toMatchObject({ state: 'UNKNOWN' });
    // an ACL0 that is already owner-only cannot be told apart from its frozen set
    expect(derive(FROZEN, { acl0: FROZEN })).toMatchObject({ state: 'UNKNOWN', freeze_in_place: 'UNKNOWN' });
  });
});

describe('H2 — the drain', () => {
  const row = { pid: 7 };
  it('PASSES only with zero pre-F0 transactions, zero hidden sessions and zero prepared transactions', () => {
    expect(C.evaluateDrain({ preF0Rows: [], hiddenRows: [], preparedRows: [] })).toMatchObject({ pass: true, decision: 'PASS', codes: [] });
  });
  it('WAITs on a live or idle-in-transaction pre-F0 transaction, and on a prepared transaction', () => {
    expect(C.evaluateDrain({ preF0Rows: [row], hiddenRows: [], preparedRows: [] })).toMatchObject({ pass: false, decision: 'WAIT', codes: ['DRAIN_PRE_F0_TRANSACTIONS'] });
    expect(C.evaluateDrain({ preF0Rows: [], hiddenRows: [], preparedRows: [{ gid: 'g' }] })).toMatchObject({ decision: 'WAIT', codes: ['DRAIN_PREPARED_TRANSACTIONS'] });
  });
  it('HOLDs — never PASSes — when the runner cannot see a session, even if the §2.3 SQL itself read zero', () => {
    expect(C.evaluateDrain({ preF0Rows: [], hiddenRows: [row], preparedRows: [] })).toMatchObject({ pass: false, decision: 'HOLD', codes: ['DRAIN_HIDDEN_SESSIONS'] });
    expect(C.evaluateDrain({ preF0Rows: [row], hiddenRows: [row], preparedRows: [{ gid: 'g' }] }).decision).toBe('HOLD');
  });
  it('refuses to decide on a missing read', () => {
    expectRefusal(() => C.evaluateDrain({ preF0Rows: [], hiddenRows: [] } as never), 'DRAIN_INPUT_MISSING');
  });
});

describe('H6 — governed resolution of S0 ∪ S1', () => {
  const rejected = (id: string, o: Record<string, unknown> = {}) => ({
    id, status: 'rejected', organization_id: ORG, revision_xmin: '900',
    reject_audits: [{ audit_id: 'a1', organization_id: ORG, from_status: 'submitted', to_status: 'rejected', xmin: '900' }], ...o,
  });
  it('unions S0 and S1 without duplicates, sorted', () => {
    expect(C.submittedUnion(['b', 'a'], ['c', 'a'])).toEqual(['a', 'b', 'c']);
  });
  it('plans: submitted => reject; rejected with canonical, physically bound evidence => already resolved; anything else => STOP', () => {
    expect(C.planResolution([
      { id: 's', status: 'submitted' }, rejected('r'), { id: 'a', status: 'approved' }, { id: 'm', status: null },
      rejected('f', { reject_audits: [{ audit_id: 'x', organization_id: ORG, from_status: 'submitted', to_status: 'rejected', xmin: '901' }] }),
    ])).toEqual([
      { id: 's', action: 'reject' }, { id: 'r', action: 'already_rejected' }, { id: 'a', action: 'stop', status: 'approved' },
      { id: 'm', action: 'stop', status: null }, { id: 'f', action: 'stop', status: 'rejected' },
    ]);
  });
  it('the canonical reject evidence needs the same organization, submitted -> rejected, and the SAME physical transaction', () => {
    expect(C.canonicalRejectEvidence(rejected('r'))).toMatchObject({ audit_id: 'a1' });
    expect(C.canonicalRejectEvidence(rejected('r', { organization_id: ORG2 }))).toBeNull();
    expect(C.canonicalRejectEvidence(rejected('r', { revision_xmin: '1' }))).toBeNull();
    expect(C.canonicalRejectEvidence({ ...rejected('r'), status: 'approved' })).toBeNull();
  });
  it('assesses the outcome: every id rejected with evidence, else STOP with the reason per id', () => {
    expect(C.assessResolution({ union: ['r'], evidenceRows: [rejected('r')] })).toEqual({ pass: true, failures: [], resolved: 1 });
    const bad = C.assessResolution({
      union: ['a', 'm', 'n', 'x'],
      evidenceRows: [{ id: 'a', status: 'approved' }, { id: 'm', status: null }, rejected('x', { reject_audits: [] })],
    });
    expect(bad.pass).toBe(false);
    expect(bad.failures).toEqual([
      { id: 'a', code: 'RESOLUTION_STATUS_UNEXPECTED', status: 'approved' }, { id: 'm', code: 'REVISION_NOT_FOUND' },
      { id: 'n', code: 'REVISION_NOT_FOUND' }, { id: 'x', code: 'RESOLUTION_EVIDENCE_MISSING' },
    ]);
  });
});

describe('H5 — physical same-transaction evidence, never payload strings alone', () => {
  const xmin = '123456';
  const txid = String(7n * 4294967296n + 123456n); // epoch 7
  const gate = { action: C.ACTION_GATE, entity_id: 'r', organization_id: ORG, actor_id: OP, txid, contract: 'c5-v1', xmin, created_at: '2026-09-26T10:00:00.000001Z' };
  const approve = { action: C.ACTION_APPROVE, entity_id: 'r', organization_id: ORG, actor_id: OP, approval_gate_txid: txid, xmin, created_at: gate.created_at };
  it('matches a gate and an approve audit written by one transaction (epoch-qualified txid mod 2^32 = xmin)', () => {
    expect(C.isPhysicalSameTransaction(gate, approve)).toBe(true);
    expect(C.isPayloadMatch(gate, approve)).toBe(true);
  });
  it('rejects a payload-matching pair from separate transactions (xmin / created_at / txid arithmetic)', () => {
    expect(C.isPhysicalSameTransaction({ ...gate, xmin: '123457' }, { ...approve, xmin: '123457' })).toBe(false); // txid mod 2^32 != xmin
    expect(C.isPhysicalSameTransaction(gate, { ...approve, xmin: '999' })).toBe(false);
    expect(C.isPhysicalSameTransaction(gate, { ...approve, created_at: '2026-09-26T10:00:00.000002Z' })).toBe(false);
    expect(C.isPayloadMatch({ ...gate, xmin: '1' }, { ...approve, xmin: '2' })).toBe(true); // what a forger can reproduce
  });
  it('rejects every other mismatch', () => {
    expect(C.isPhysicalSameTransaction({ ...gate, contract: 'c4' }, approve)).toBe(false);
    expect(C.isPhysicalSameTransaction({ ...gate, entity_id: 'q' }, approve)).toBe(false);
    expect(C.isPhysicalSameTransaction({ ...gate, organization_id: ORG2 }, approve)).toBe(false);
    expect(C.isPhysicalSameTransaction({ ...gate, actor_id: null }, approve)).toBe(false);
    expect(C.isPhysicalSameTransaction({ ...gate, txid: 'abc' }, approve)).toBe(false);
    expect(C.isPhysicalSameTransaction(gate, { ...approve, approval_gate_txid: '1' })).toBe(false);
    expect(C.isPhysicalSameTransaction(gate, { ...approve, action: C.ACTION_GATE })).toBe(false);
    expect(C.isPhysicalSameTransaction(null, approve)).toBe(false);
  });
});

describe('H4 — Proof A: lifecycle-state delta from A0, both directions, expected EMPTY', () => {
  const r = (id: string, status: string, o: Record<string, unknown> = {}) => ({
    id, status, plan_id: `plan-${id}`, organization_id: ORG, revision_number: 1, approved_by: OP,
    approved_at: '2026-09-01T00:00:00.000000Z', updated_at: '2026-09-01T00:00:00.000000Z', ...o,
  });
  const a0 = [r('p1', 'approved'), r('p2', 'approved'), r('p3', 'approved'), r('p4', 'approved'), r('p5', 'superseded'), r('l', 'approved'), r('ok', 'approved')];
  it('is EMPTY (PASS) when nothing moved', () => {
    expect(C.evaluateProofA({ a0, current: [...a0].reverse() })).toEqual({ pass: true, deltas: [], kinds: [] });
  });
  it('classifies approval, supersede, demotion, deletion, re-parenting and round-trip', () => {
    const current = [
      r('d1', 'approved'),                                   // new approval
      r('p1', 'superseded'),                                 // approved -> superseded
      r('p2', 'draft', { approved_by: null, approved_at: null }), // demotion
      r('p3', 'approved', { plan_id: 'elsewhere' }),         // re-parented
      r('p4', 'approved', { approved_at: '2026-09-26T00:00:00.000000Z', updated_at: '2026-09-26T00:00:00.000000Z' }), // round trip
      r('p5', 'approved'),                                   // superseded -> approved again
      r('s1', 'superseded'),                                 // superseded without ever being in A0
      r('ok', 'approved'),
      // 'l' deleted
    ];
    const out = C.evaluateProofA({ a0, current, t0: '2026-09-20T00:00:00.000000Z' });
    expect(out.pass).toBe(false);
    expect(Object.fromEntries(out.deltas.map((d) => [d.id, d.kind]))).toEqual({
      d1: 'approval', p1: 'supersede', p2: 'demotion', p3: 're_parent', p4: 'round_trip', p5: 'approval', s1: 'supersede', l: 'deletion',
    });
    expect(out.deltas.find((d) => d.id === 'p3')!.fields).toEqual(['plan_id']);
    expect(out.deltas.find((d) => d.id === 'p4')!.fields).toEqual(['approved_at', 'updated_at']);
    expect(out.kinds).toEqual(['approval', 'deletion', 'demotion', 're_parent', 'round_trip', 'supersede']);
  });
  it('annotates an approval whose audit is OLDER than T0 (a straddler) — and still counts it', () => {
    const audits = [{ audit_id: 'x', action: C.ACTION_APPROVE, entity_id: 'd1', created_at: '2026-09-19T23:59:59.000000Z', approval_gate_txid: null }];
    const out = C.evaluateProofA({ a0: [], current: [r('d1', 'approved')], audits, t0: '2026-09-20T00:00:00.000000Z' });
    expect(out.pass).toBe(false);
    expect(out.deltas[0].evidence).toMatchObject({ approve_audits: [{ audit_id: 'x', before_t0: true }], physical_gate_match: false });
  });
  it('a forged gate + approve pair is a payload match but not a physical one; ANY delta is still a HOLD', () => {
    const audits = [
      { audit_id: 'g', action: C.ACTION_GATE, entity_id: 'd2', organization_id: ORG, actor_id: OP, txid: '424242', contract: 'c5-v1', xmin: '10', created_at: 'T' },
      { audit_id: 'a', action: C.ACTION_APPROVE, entity_id: 'd2', organization_id: ORG, actor_id: OP, approval_gate_txid: '424242', xmin: '11', created_at: 'T' },
    ];
    const out = C.evaluateProofA({ a0: [], current: [r('d2', 'approved')], audits });
    expect(out.deltas[0].evidence).toMatchObject({ payload_gate_match: true, physical_gate_match: false });
    expect(out.pass).toBe(false);
  });
});

describe('H5 — Proof B: approve audits at/after T0 need a physically bound gate; expected EMPTY in the window', () => {
  const txid = '123456';
  const gate = { audit_id: 'g', action: C.ACTION_GATE, entity_id: 'r', organization_id: ORG, actor_id: OP, txid, contract: 'c5-v1', xmin: '123456', created_at: 'T', at_or_after_t0: true };
  const approve = { audit_id: 'a', action: C.ACTION_APPROVE, entity_id: 'r', organization_id: ORG, actor_id: OP, approval_gate_txid: txid, xmin: '123456', created_at: 'T', at_or_after_t0: true };
  it('PASSES only when nothing was approved or gated at/after T0', () => {
    expect(C.evaluateProofB({ rows: [] })).toMatchObject({ pass: true, approvals: [], unmatched: [], gates_at_or_after_t0: 0, orphan_gates: [] });
  });
  it('a canonical pair is classified as physically matched — but in the frozen window it is still not EMPTY', () => {
    const out = C.evaluateProofB({ rows: [gate, approve] });
    expect(out.approvals).toEqual([{ audit_id: 'a', entity_id: 'r', created_at: 'T', physical_match: true, payload_match: true }]);
    expect(out.unmatched).toEqual([]);
    expect(out.pass).toBe(false);
  });
  it('a forged pair from separate transactions is UNMATCHED; an orphan gate is reported', () => {
    const forged = C.evaluateProofB({ rows: [{ ...gate, xmin: '1' }, { ...approve, xmin: '2' }] });
    expect(forged.unmatched).toEqual(['a']);
    expect(forged.approvals[0]).toMatchObject({ payload_match: true, physical_match: false });
    expect(C.evaluateProofB({ rows: [gate] }).orphan_gates).toEqual([{ audit_id: 'g', entity_id: 'r', created_at: 'T' }]);
    // an approve audit older than T0 is out of Proof B's scope (Proof A covers it)
    expect(C.evaluateProofB({ rows: [{ ...approve, at_or_after_t0: false }] }).pass).toBe(true);
  });
});

describe('H11 — the lifecycle-audit census backstop', () => {
  const a = (id: string, action: string, entity: string, o: Record<string, unknown> = {}) => ({ id, action, entity_id: entity, organization_id: ORG, created_at: 'T', ...o });
  const l0 = [a('1', C.ACTION_SUBMIT, 's0'), a('2', C.ACTION_APPROVE, 'p')];
  it('allows exactly one reject per governed id and the submit of a straddling S1 revision', () => {
    const current = [...l0, a('3', C.ACTION_REJECT, 's0'), a('4', C.ACTION_SUBMIT, 's1'), a('5', C.ACTION_REJECT, 's1')];
    expect(C.evaluateLifecycleAuditCensus({ l0, current, union: ['s0', 's1'], s0: ['s0'] })).toMatchObject({ pass: true, added: 3, unexpected_added: [] });
  });
  it('HOLDs on any other addition, a second reject, a removal or an edited row', () => {
    const base = { l0, union: ['s0'], s0: ['s0'] };
    expect(C.evaluateLifecycleAuditCensus({ ...base, current: [...l0, a('3', C.ACTION_APPROVE, 'd')] }).pass).toBe(false);
    expect(C.evaluateLifecycleAuditCensus({ ...base, current: [...l0, a('3', C.ACTION_GATE, 'd')] }).pass).toBe(false);
    expect(C.evaluateLifecycleAuditCensus({ ...base, current: [...l0, a('3', C.ACTION_SUBMIT, 's0')] }).pass).toBe(false);
    expect(C.evaluateLifecycleAuditCensus({ ...base, current: [...l0, a('3', C.ACTION_REJECT, 's0'), a('4', C.ACTION_REJECT, 's0')] }).unexpected_added).toHaveLength(1);
    expect(C.evaluateLifecycleAuditCensus({ ...base, current: [l0[0]] }).removed).toHaveLength(1);
    const backdated = C.evaluateLifecycleAuditCensus({ ...base, current: [l0[0], { ...l0[1], created_at: 'EARLIER' }] });
    expect(backdated.pass).toBe(false);
    expect(backdated.changed).toHaveLength(1);
  });
  it('D-10: a straddling submit rejected before S1 is NOT admitted (fail-closed) — the pattern is only named as evidence', () => {
    const base = { l0, union: ['s0'], s0: ['s0'] };
    const out = C.evaluateLifecycleAuditCensus({ ...base, current: [...l0, a('3', C.ACTION_REJECT, 's0'), a('4', C.ACTION_SUBMIT, 'z'), a('5', C.ACTION_REJECT, 'z')] });
    expect(out.pass).toBe(false);
    expect(out.unexpected_added.map((r) => r.id)).toEqual(['4', '5']);
    expect(out.straddler_pattern).toEqual(['z']);
    // anything else (a lone reject, a submit + approve) is not that pattern
    expect(C.evaluateLifecycleAuditCensus({ ...base, current: [...l0, a('4', C.ACTION_SUBMIT, 'z'), a('5', C.ACTION_APPROVE, 'z')] }).straddler_pattern).toEqual([]);
    expect(C.evaluateLifecycleAuditCensus({ ...base, current: [...l0, a('5', C.ACTION_REJECT, 'z')] }).straddler_pattern).toEqual([]);
  });
  it('D-09: the audit ids a disposition must acknowledge are every removed, edited and unexpectedly added row', () => {
    const base = { l0, union: ['s0'], s0: ['s0'] };
    const out = C.evaluateLifecycleAuditCensus({ ...base, current: [{ ...l0[1], created_at: 'EARLIER' }, a('3', C.ACTION_REJECT, 's0'), a('9', C.ACTION_GATE, 'd')] });
    expect(C.censusDeltaIds(out)).toEqual(['1', '2', '9']);
    expect(C.censusDeltaIds(C.evaluateLifecycleAuditCensus({ ...base, current: l0 }))).toEqual([]);
  });
});

describe('H9 — the M217 outcome, from history + catalog facts', () => {
  const objects = (v: boolean) => Object.fromEntries(Object.keys(C.M217_OBJECTS).map((k) => [k, v]));
  const bodies = (v: boolean | null) => Object.fromEntries(C.M217_BODY_MARKERS.map((m) => [m.fn, v]));
  it('APPLIED needs the history row, every object and every C5 body', () => {
    expect(C.classifyM217Outcome({ historyReadable: true, historyRowPresent: true, objects: objects(true), bodies: bodies(true) }).outcome).toBe('APPLIED');
  });
  const fp = (c: string) => Object.fromEntries(C.FINGERPRINT_SIGNATURES.map((s) => [s, c.repeat(32)]));
  const proof = (o: Record<string, unknown> = {}) => ({
    requireExecutor: true, executor: { run_id: '36026915933', conclusion: 'failure' },
    inFlight: { locks: [], sessions: [], hidden: [] }, t0Fingerprints: fp('a'), fingerprints: fp('a'),
    historyRowCount: 216, attestedRowCount: 216, ...o,
  });
  const clean = (o: Record<string, unknown> = {}) =>
    C.classifyM217Outcome({ historyReadable: true, historyRowPresent: false, objects: objects(false), bodies: bodies(false), nonCommit: proof(o) });
  it('FAILED_CLEAN needs the history row absent, every object absent and every body pre-C5 (approve included) — AND the full non-commit proof', () => {
    expect(clean()).toMatchObject({ outcome: 'FAILED_CLEAN', non_commit_proven: true });
    for (const conclusion of ['cancelled', 'not_dispatched']) {
      expect(clean({ executor: { run_id: conclusion === 'cancelled' ? '7' : null, conclusion } }).outcome).toBe('FAILED_CLEAN');
    }
    // before READY_FOR_M217 no executor can have been dispatched, so its state is not required
    expect(clean({ requireExecutor: false, executor: null }).outcome).toBe('FAILED_CLEAN');
  });
  it('D-02: absent from the catalog but NOT proven non-committed is UNKNOWN (never a restore)', () => {
    const unknown = (o: Record<string, unknown>, needle: RegExp) => {
      const out = clean(o);
      expect(out.outcome, JSON.stringify(o)).toBe('UNKNOWN');
      expect(out.unproven.join(' | ')).toMatch(needle);
    };
    unknown({ executor: null }, /executor terminal state was not supplied/);
    unknown({ executor: { run_id: '9', conclusion: 'success' } }, /reports success/);
    unknown({ executor: { run_id: 'x', conclusion: 'failure' } }, /malformed/);
    unknown({ inFlight: { locks: [{ pid: 9, relation: 'central_needs_source_records', mode: 'AccessExclusiveLock', granted: true }], sessions: [], hidden: [] } }, /lock\(s\) on the §1 relations/);
    unknown({ inFlight: { locks: [], sessions: [{ pid: 9 }], hidden: [] } }, /running M217 text/);
    unknown({ inFlight: { locks: [], sessions: [], hidden: [9] } }, /hidden/);
    unknown({ inFlight: null }, /in-flight M217 check could not be read/);
    unknown({ t0Fingerprints: null }, /no T0 body fingerprint/);
    unknown({ fingerprints: null }, /current body fingerprints could not be read/);
    unknown({ fingerprints: { ...fp('a'), [C.APPROVE_SIGNATURE]: 'b'.repeat(32) } }, /approve_revision\(uuid\) is not the T0 body/);
    unknown({ fingerprints: { ...fp('a'), [C.M217_BODY_MARKERS[5].fn]: null } }, /is not the T0 body/);
    unknown({ historyRowCount: 217 }, /history carries 217 rows, attested 216/);
    unknown({ attestedRowCount: undefined }, /attested \(none\)/);
    expect(C.classifyM217Outcome({ historyReadable: true, historyRowPresent: false, objects: objects(false), bodies: bodies(false) }))
      .toMatchObject({ outcome: 'UNKNOWN', unproven: ['the non-commit proof inputs were not supplied'] });
    expect(C.FINGERPRINT_SIGNATURES).toEqual(expect.arrayContaining([C.APPROVE_SIGNATURE, C.SUBMIT_SIGNATURE, C.REJECT_SIGNATURE,
      'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)']));
  });
  it('a present M217 is APPLIED / FAILED_PARTIAL whatever the executor reports', () => {
    expect(C.classifyM217Outcome({ historyReadable: true, historyRowPresent: true, objects: objects(true), bodies: bodies(true), nonCommit: proof() }).outcome).toBe('APPLIED');
    expect(C.classifyM217Outcome({ historyReadable: true, historyRowPresent: false, objects: { ...objects(false), classifier: true }, bodies: bodies(false), nonCommit: proof() }).outcome)
      .toBe('FAILED_PARTIAL');
  });
  it('anything in between is FAILED_PARTIAL; an unreadable fact is UNKNOWN', () => {
    const partial = (o: Record<string, unknown>) => C.classifyM217Outcome({ historyReadable: true, historyRowPresent: false, objects: objects(false), bodies: bodies(false), ...o }).outcome;
    expect(partial({ objects: { ...objects(false), fenceFunction: true } })).toBe('FAILED_PARTIAL');
    expect(partial({ historyRowPresent: true })).toBe('FAILED_PARTIAL');
    expect(partial({ historyRowPresent: true, objects: objects(true), bodies: { ...bodies(true), [C.APPROVE_SIGNATURE]: false } })).toBe('FAILED_PARTIAL');
    expect(partial({ bodies: { ...bodies(false), [C.APPROVE_SIGNATURE]: true } })).toBe('FAILED_PARTIAL');
    expect(partial({ bodies: { ...bodies(false), [C.APPROVE_SIGNATURE]: null } })).toBe('FAILED_PARTIAL');
    expect(C.classifyM217Outcome({ historyReadable: false, objects: objects(false), bodies: bodies(false) }).outcome).toBe('UNKNOWN');
    expect(C.classifyM217Outcome({ historyReadable: true, historyRowPresent: false, objects: null, bodies: bodies(false) }).outcome).toBe('UNKNOWN');
    expect(C.classifyM217Outcome({ historyReadable: true, historyRowPresent: false, objects: { classifier: false }, bodies: bodies(false) }).outcome).toBe('UNKNOWN');
  });
  it('the markers are the frozen C5 names and codes, one per replaced function', () => {
    expect(C.M217_BODY_MARKERS.map((m) => m.fn)).toHaveLength(7);
    expect(C.M217_BODY_MARKERS.find((m) => m.fn === C.APPROVE_SIGNATURE)!.marker).toBe('approval_gate_txid');
    expect(C.M217_OBJECTS).toEqual({
      classifier: 'public._phoenix_central_needs_review_numeric_class_v1(jsonb)',
      lineageHelper: 'public._phoenix_central_needs_quantity_lineage_violation_v1(uuid)',
      fenceFunction: 'public._phoenix_central_needs_approval_gate_fence_v1()',
      fenceTrigger: 'central_needs_plan_revisions_c5_approval_gate',
      valueContract: 'central_needs_source_records_c5_value_contract',
    });
  });
});

describe('H10 — post-apply verification', () => {
  const attestation = C.attestProductionHistory(attestArgs());
  const passing = () => ({
    remoteRows: [...productionThrough216(), { version: TARGET_VERSION, name: C.M217_HISTORY_NAME }],
    localMigrations: local(), attestation, localM217Sha256: M217_SHA,
    overloads: Object.fromEntries(C.EXACT_OVERLOAD_NAMES.map((n) => [n, 1])),
    classifier: { volatile: 'i', secdef: false, strict: false, search_path_pinned: true, returns: 'text', authenticated: true, service_role: true, anon: false, public_entry: false },
    lineageHelper: { volatile: 's', secdef: true, strict: false, search_path_pinned: true, returns: 'text', authenticated: false, service_role: false, anon: false, public_entry: false },
    fenceFunction: { volatile: 'v', secdef: true, strict: false, search_path_pinned: true, returns: 'trigger', authenticated: false, service_role: false, anon: false, public_entry: false },
    fenceTrigger: { type: 23, column_list: '', enabled: 'O', function: C.M217_OBJECTS.fenceFunction },
    valueContract: { type: 'c', validated: false },
    blockerVocabulary: { source_cell_value_contract_invalid: true, need_line_quantity_lineage_unsafe: true },
    bodies: Object.fromEntries(C.M217_BODY_MARKERS.map((m) => [m.fn, true])),
    submittedIds: [], drain: { pass: true }, resolution: { pass: true, failures: [] },
    proofA: { pass: true, deltas: [] }, proofB: { pass: true }, census: { pass: true },
    lifecycleWriters: [
      ...C.EXPECTED_STATUS_WRITERS.map((fn) => ({ fn, updates_status: true, inserts_revision: false })),
      ...C.EXPECTED_REVISION_INSERTERS.map((fn) => ({ fn, updates_status: false, inserts_revision: true })),
    ],
    frozenAcl: FROZEN, aclNow: [...FROZEN].reverse(), rejectAcl0: REJECT_ACL, rejectAclNow: REJECT_ACL,
  });
  const codes = (o: Record<string, unknown>) => C.evaluatePostApply({ ...passing(), ...o }).failures.map((f) => f.code);
  it('PASSES only when every invariant holds', () => {
    expect(C.evaluatePostApply(passing())).toEqual({ pass: true, failures: [] });
  });
  it('fails on each invariant, collecting every failure', () => {
    expect(codes({ remoteRows: productionThrough216() })).toContain('POST_APPLY_HISTORY_IDENTITY');
    expect(codes({ remoteRows: [...productionThrough216(), { version: TARGET_VERSION, name: '217_other' }] })).toContain('POST_APPLY_HISTORY_IDENTITY');
    expect(codes({ remoteRows: [...productionThrough216({ 216: { version: '20260924124059' } }), { version: TARGET_VERSION, name: C.M217_HISTORY_NAME }] }))
      .toContain('POST_APPLY_M216_ROW_MOVED');
    expect(codes({ localM217Sha256: 'd'.repeat(64) })).toEqual(['POST_APPLY_M217_BYTES_CHANGED']);
    expect(codes({ overloads: { ...passing().overloads, phoenix_central_needs_approve_revision: 2 } })).toEqual(['POST_APPLY_OVERLOAD_MISMATCH']);
    expect(codes({ classifier: { ...passing().classifier, strict: true } })).toEqual(['POST_APPLY_CLASSIFIER_CONTRACT']);
    expect(codes({ classifier: { ...passing().classifier, anon: true } })).toEqual(['POST_APPLY_CLASSIFIER_CONTRACT']);
    expect(codes({ lineageHelper: { ...passing().lineageHelper, service_role: true } })).toEqual(['POST_APPLY_LINEAGE_HELPER_CONTRACT']);
    expect(codes({ fenceFunction: null })).toEqual(['POST_APPLY_FENCE_FUNCTION_CONTRACT']);
    expect(codes({ fenceTrigger: { ...passing().fenceTrigger, column_list: '4' } })).toEqual(['POST_APPLY_FENCE_MISSING']);
    expect(codes({ fenceTrigger: { ...passing().fenceTrigger, type: 19 } })).toEqual(['POST_APPLY_FENCE_MISSING']); // UPDATE only
    expect(codes({ fenceTrigger: { ...passing().fenceTrigger, enabled: 'D' } })).toEqual(['POST_APPLY_FENCE_MISSING']);
    expect(codes({ valueContract: { type: 'c', validated: true } })).toEqual(['POST_APPLY_VALUE_CONTRACT']);
    expect(codes({ blockerVocabulary: { source_cell_value_contract_invalid: true } })).toEqual(['POST_APPLY_BLOCKER_VOCABULARY']);
    expect(codes({ bodies: { ...passing().bodies, [C.APPROVE_SIGNATURE]: false } })).toEqual(['POST_APPLY_BODY_NOT_C5']);
    expect(codes({ submittedIds: ['x'] })).toEqual(['POST_APPLY_SUBMITTED_PRESENT']);
    expect(codes({ drain: { pass: false } })).toEqual(['POST_APPLY_DRAIN_NOT_ZERO']);
    expect(codes({ resolution: { pass: false, failures: [{ id: 'x' }] } })).toEqual(['POST_APPLY_RESOLUTION_REGRESSED']);
    expect(codes({ proofA: { pass: false, deltas: [{ id: 'x' }] } })).toEqual(['POST_APPLY_PROOF_A_DELTA']);
    expect(codes({ proofB: { pass: false } })).toEqual(['POST_APPLY_PROOF_B_UNMATCHED']);
    expect(codes({ census: { pass: false } })).toEqual(['POST_APPLY_LIFECYCLE_AUDIT_DELTA']);
    expect(codes({ lifecycleWriters: [...passing().lifecycleWriters, { fn: 'public.rogue()', updates_status: true, inserts_revision: false }] }))
      .toEqual(['POST_APPLY_UNEXPECTED_LIFECYCLE_WRITER']);
    expect(codes({ lifecycleWriters: passing().lifecycleWriters.slice(1) })).toEqual(['POST_APPLY_UNEXPECTED_LIFECYCLE_WRITER']);
    expect(codes({ lifecycleWriters: null })).toEqual(['POST_APPLY_UNEXPECTED_LIFECYCLE_WRITER']);
    expect(codes({ aclNow: [...FROZEN, t(C.SUBMIT_SIGNATURE, 'authenticated')] })).toEqual(['POST_APPLY_ACL_FROZEN_CHANGED']);
    expect(codes({ rejectAclNow: REJECT_ACL.slice(1) })).toEqual(['POST_APPLY_REJECT_ACL_CHANGED']);
    expect(codes({ submittedIds: ['x'], census: { pass: false }, proofA: { pass: false } })).toHaveLength(3);
  });
});

describe('H13 / §12 — the post-apply DRAFT audit is sealed but workflow-scoped', () => {
  it('summarizes chronology ambiguity, non-head pins (required vs informational), lineage and invalid evidence', () => {
    expect(C.summarizeDraftAudit({
      chronology: [{ plan_revision_id: 'r1' }],
      pins: [{ plan_revision_id: 'r2', required_pin: true }, { plan_revision_id: 'r3', required_pin: false }],
      lineage: [{ plan_revision_id: 'r2' }], invalidEvidence: [{ plan_revision_id: 'r4' }],
    })).toEqual({
      chronology_ambiguity: 1, non_head_pins: 2, unsafe_required_pins: 1, unsafe_lineage_links: 1, invalid_source_evidence: 1,
      draft_workflow_holds: ['r1', 'r2', 'r4'],
    });
    expect(C.summarizeDraftAudit({}).draft_workflow_holds).toEqual([]);
  });
});

describe('§21.8 / D-10 — READY_FOR_M217 preconditions, all collected', () => {
  const ok = () => ({
    submittedIds: [], m217: { outcome: 'FAILED_CLEAN' }, aclStillFrozen: true,
    proofA: { pass: true, deltas: [] }, proofB: { pass: true }, census: { pass: true },
  });
  const codes = (o: Record<string, unknown>) => C.assessReadyForM217({ ...ok(), ...o }).failures.map((f) => f.code);
  it('PASSES only with zero submitted, M217 proven absent, the frozen ACL and clean accounting', () => {
    expect(C.assessReadyForM217(ok())).toEqual({ pass: true, failures: [] });
  });
  it('any accounting delta — including the D-10 straddler census pattern — is a STOP before M217, not a post-apply HOLD', () => {
    expect(codes({ submittedIds: ['x'] })).toEqual(['READY_SUBMITTED_PRESENT']);
    expect(codes({ m217: { outcome: 'UNKNOWN' } })).toEqual(['READY_M217_NOT_PROVEN_ABSENT']);
    expect(codes({ aclStillFrozen: false })).toEqual(['READY_ACL_NOT_FROZEN']);
    expect(codes({ proofA: { pass: false, deltas: [{ id: 'x' }] } })).toEqual(['READY_PROOF_A_DELTA']);
    expect(codes({ proofB: { pass: false } })).toEqual(['READY_PROOF_B_NOT_EMPTY']);
    expect(codes({ census: { pass: false, straddler_pattern: ['z'] } })).toEqual(['READY_LIFECYCLE_AUDIT_DELTA']);
    expect(codes({ submittedIds: undefined, m217: undefined, aclStillFrozen: undefined, proofA: undefined, proofB: undefined, census: undefined }))
      .toHaveLength(6);
  });
});

describe('the ordered model and the H3 attempt ledger', () => {
  it('runs the steps strictly in order', () => {
    expect(C.ACTIVATION_STEPS[0]).toBe('HISTORY_ATTESTED');
    expect(C.ACTIVATION_STEPS.indexOf('T0_SNAPSHOT_SEALED')).toBeGreaterThan(C.ACTIVATION_STEPS.indexOf('OPERATOR_ATTESTED'));
    expect(C.ACTIVATION_STEPS.indexOf('READY_FOR_M217')).toBeLessThan(C.ACTIVATION_STEPS.indexOf('M217_OUTCOME_CLASSIFIED'));
    expect(C.ACTIVATION_STEPS.at(-2)).toBe('ACL_RESTORED');
    expect(C.assertStepInOrder([], 'HISTORY_ATTESTED')).toBe(true);
    expect(C.assertStepInOrder(C.ACTIVATION_STEPS.slice(0, 5), 'ACL_FROZEN')).toBe(true);
    expectRefusal(() => C.assertStepInOrder([], 'ACL_FROZEN'), 'STEP_OUT_OF_ORDER');
    expectRefusal(() => C.assertStepInOrder(['RUNNER_ATTESTED'], 'OPERATOR_ATTESTED'), 'STEP_OUT_OF_ORDER');
    expectRefusal(() => C.assertStepInOrder([...C.ACTIVATION_STEPS], 'RESTORE_VERIFIED'), 'STEP_OUT_OF_ORDER');
  });
  it('a concluded attempt is closed; STOP exists only between T0 and the M217 outcome', () => {
    expectRefusal(() => C.assertAttemptOpen({ attempt_id: 'a', conclusion: { outcome: C.C5_ACTIVATION_HOLD } }), 'ATTEMPT_ALREADY_CONCLUDED');
    expect(C.assertCanStop({ completed: C.ACTIVATION_STEPS.slice(0, 5) })).toBe(true);
    expectRefusal(() => C.assertCanStop({ completed: C.ACTIVATION_STEPS.slice(0, 4) }), 'STOP_BEFORE_T0');
    expectRefusal(() => C.assertCanStop({ completed: C.ACTIVATION_STEPS.slice(0, 13) }), 'STOP_AFTER_M217');
  });
  const prior = (o: Record<string, unknown> = {}) => ({
    attempt_id: 'attempt-001', manifest_ok: true, t0: 'T0', acl0: ACL0, frozen_acl: FROZEN,
    conclusion: { outcome: C.C5_ACTIVATION_HOLD, freeze_in_place: false }, ...o,
  });
  const disp = (o: Record<string, unknown> = {}) => ({ attempt_id: 'attempt-001', decision: 'retry', owner_reference: 'OWNER-1', acknowledged_delta_ids: [], ...o });
  it('every earlier non-PASS attempt must be dispositioned, with EXACTLY the deltas measured against its own T0/A0', () => {
    expect(C.assertPriorAttemptsDispositioned({ priorAttempts: [prior()], dispositions: [disp()] }))
      .toEqual({
        dispositioned: ['attempt-001'], inheritedAcl0: null, inheritedFrom: null, carry_forward: false, rebaseline: false,
        expectation: { kind: 'NOT_FROZEN', from: 'attempt-001', acl0: ACL0, frozen: FROZEN, freeze_in_place: false },
      });
    expectRefusal(() => C.assertPriorAttemptsDispositioned({ priorAttempts: [prior()], dispositions: [] }), 'PRIOR_ATTEMPT_UNDISPOSITIONED');
    expectRefusal(() => C.assertPriorAttemptsDispositioned({ priorAttempts: [prior()], dispositions: [disp({ owner_reference: ' ' })] }), 'PRIOR_ATTEMPT_UNDISPOSITIONED');
    expectRefusal(() => C.assertPriorAttemptsDispositioned({ priorAttempts: [prior()], dispositions: [disp()], priorDeltas: { 'attempt-001': ['z'] } }),
      'PRIOR_ATTEMPT_DELTA_UNDISPOSITIONED');
    expectRefusal(() => C.assertPriorAttemptsDispositioned({ priorAttempts: [prior()], dispositions: [disp({ acknowledged_delta_ids: ['z', 'y'] })], priorDeltas: { 'attempt-001': ['z'] } }),
      'PRIOR_ATTEMPT_DELTA_UNDISPOSITIONED');
    expect(C.assertPriorAttemptsDispositioned({ priorAttempts: [prior()], dispositions: [disp({ acknowledged_delta_ids: ['z'] })], priorDeltas: new Map([['attempt-001', ['z']]]) }).dispositioned)
      .toEqual(['attempt-001']);
  });
  it('refuses tampered evidence and an unconcluded prior attempt; skips PASS and pre-T0 refusals', () => {
    expectRefusal(() => C.assertPriorAttemptsDispositioned({ priorAttempts: [prior({ manifest_ok: false })], dispositions: [disp()] }), 'PRIOR_ATTEMPT_EVIDENCE_TAMPERED');
    expectRefusal(() => C.assertPriorAttemptsDispositioned({ priorAttempts: [prior({ conclusion: null })] }), 'PRIOR_ATTEMPT_UNCONCLUDED');
    expect(C.assertPriorAttemptsDispositioned({ priorAttempts: [
      prior({ conclusion: { outcome: C.C5_ACTIVATION_PASS } }),
      prior({ attempt_id: 'attempt-002', t0: undefined, conclusion: { outcome: C.REFUSED_BEFORE_T0 } }),
    ] }).dispositioned).toEqual([]);
  });
  it('a prior attempt that kept the freeze must be carried forward explicitly, and then ITS ACL0 is the restoration target', () => {
    const kept = prior({ conclusion: { outcome: C.C5_ACTIVATION_HOLD, freeze_in_place: true } });
    expectRefusal(() => C.assertPriorAttemptsDispositioned({ priorAttempts: [kept], dispositions: [disp()] }), 'PRIOR_ATTEMPT_FREEZE_UNRESOLVED');
    expect(C.assertPriorAttemptsDispositioned({ priorAttempts: [kept], dispositions: [disp({ carry_forward_acl0: true })] }))
      .toMatchObject({ inheritedAcl0: ACL0, inheritedFrom: 'attempt-001' });
    expect(C.assertInheritedFreezeIntact({ capturedAcl0: [...FROZEN].reverse(), priorFrozenAcl: FROZEN })).toBe(true);
    expectRefusal(() => C.assertInheritedFreezeIntact({ capturedAcl0: ACL0, priorFrozenAcl: FROZEN }), 'PRIOR_FROZEN_ACL_CHANGED');
  });
  it('D-03: ANY freeze_in_place that is not exactly false — "UNKNOWN", a legacy string, missing — demands carry-forward or an Owner rebaseline', () => {
    for (const fip of ['UNKNOWN', 'UNRECORDED_ACL_CHANGE', undefined, null]) {
      const uncertain = prior({ conclusion: { outcome: C.C5_ACTIVATION_HOLD, freeze_in_place: fip } });
      expectRefusal(() => C.assertPriorAttemptsDispositioned({ priorAttempts: [uncertain], dispositions: [disp()] }), 'PRIOR_ATTEMPT_FREEZE_UNRESOLVED');
      expect(C.assertPriorAttemptsDispositioned({ priorAttempts: [uncertain], dispositions: [disp({ carry_forward_acl0: true })] }))
        .toMatchObject({ carry_forward: true, inheritedAcl0: ACL0, expectation: { kind: 'UNCERTAIN' } });
      expect(C.assertPriorAttemptsDispositioned({ priorAttempts: [uncertain], dispositions: [disp({ acl_rebaseline: true })] }))
        .toMatchObject({ carry_forward: false, rebaseline: true, inheritedAcl0: null });
    }
    expectRefusal(() => C.assertPriorAttemptsDispositioned({
      priorAttempts: [prior({ conclusion: { outcome: C.C5_ACTIVATION_HOLD, freeze_in_place: true } })],
      dispositions: [disp({ carry_forward_acl0: true, acl_rebaseline: true })],
    }), 'PRIOR_ATTEMPT_DISPOSITION_CONFLICT');
  });
  it('D-03: only the LAST attempt with a T0 decides the ledger state; one that already carried an earlier freeze forward supersedes it', () => {
    const one = prior({ conclusion: { outcome: C.C5_ACTIVATION_HOLD, freeze_in_place: true } });
    // attempt 2 inherited attempt 1's ACL0 and restored it (STOP) — the freeze is resolved
    const two = prior({
      attempt_id: 'attempt-002', acl0: FROZEN, restoration_target_acl0: ACL0, frozen_acl: FROZEN,
      conclusion: { outcome: C.C5_ACTIVATION_HOLD, freeze_in_place: false },
    });
    const v = C.assertPriorAttemptsDispositioned({ priorAttempts: [one, two], dispositions: [disp({ carry_forward_acl0: true }), disp({ attempt_id: 'attempt-002' })] });
    expect(v).toMatchObject({ carry_forward: false, inheritedAcl0: null, expectation: { kind: 'NOT_FROZEN', from: 'attempt-002', acl0: ACL0, frozen: FROZEN } });
    // a later attempt refused before T0 does not move the ledger state
    const three = prior({ attempt_id: 'attempt-003', t0: undefined, conclusion: { outcome: C.REFUSED_BEFORE_T0 } });
    expect(C.ledgerAclExpectation([one, three])).toMatchObject({ kind: 'FROZEN', from: 'attempt-001' });
    expect(C.ledgerAclExpectation([])).toMatchObject({ kind: 'NONE' });
    expect(C.ledgerAclExpectation([prior({ conclusion: { outcome: C.C5_ACTIVATION_PASS } })])).toMatchObject({ kind: 'NOT_FROZEN' });
  });
  it('D-03: an attempt whose T0 gate refused carries the LEDGER ACL0 forward, never the ACL it happened to capture', () => {
    const weird = [...FROZEN, t(C.APPROVE_SIGNATURE, 'service_role')];
    const refusedGate = prior({
      attempt_id: 'attempt-002', acl0: weird, frozen_acl: undefined,
      ledger_expectation: { kind: 'NOT_FROZEN', from: 'attempt-001', acl0: ACL0, frozen: FROZEN },
      conclusion: { outcome: C.C5_ACTIVATION_HOLD, freeze_in_place: 'UNKNOWN' },
    });
    expect(C.attemptAcl0Target(refusedGate)).toEqual(ACL0);
    expect(C.attemptFrozenSet(refusedGate)).toEqual(FROZEN);
    expect(C.attemptAcl0Target(prior())).toEqual(ACL0);
    expect(C.attemptFrozenSet(prior({ frozen_acl: undefined }))).toEqual(FROZEN.map(C.normalizeAclTuple));
  });
  it('D-09: the H11 census deltas of every prior attempt must be acknowledged exactly (acknowledged_audit_ids)', () => {
    const audit = { 'attempt-001': ['aud-2', 'aud-1'] };
    expectRefusal(() => C.assertPriorAttemptsDispositioned({ priorAttempts: [prior()], dispositions: [disp()], priorAuditDeltas: audit }),
      'PRIOR_ATTEMPT_AUDIT_DELTA_UNDISPOSITIONED');
    expectRefusal(() => C.assertPriorAttemptsDispositioned({ priorAttempts: [prior()], dispositions: [disp({ acknowledged_audit_ids: ['aud-1'] })], priorAuditDeltas: audit }),
      'PRIOR_ATTEMPT_AUDIT_DELTA_UNDISPOSITIONED');
    expect(C.assertPriorAttemptsDispositioned({
      priorAttempts: [prior()], dispositions: [disp({ acknowledged_audit_ids: ['aud-1', 'aud-2'] })], priorAuditDeltas: new Map([['attempt-001', ['aud-1', 'aud-2']]]),
    }).dispositioned).toEqual(['attempt-001']);
  });
});

describe('D-03 / D-09 — the T0 ACL gate: a frozen ACL is never captured as ACL0', () => {
  const ex = (kind: string, o: Record<string, unknown> = {}) => ({ kind, from: 'attempt-001', acl0: ACL0, frozen: FROZEN, ...o });
  const gate = (capturedAcl: unknown, expectation: unknown, o: Record<string, unknown> = {}) =>
    C.assessT0Acl({ capturedAcl, expectation, ...o } as never);
  it('NONE: the first attempt captures ACL0 — only if it lets authenticated execute submit and approve', () => {
    expect(gate(ACL0, undefined)).toMatchObject({ basis: 'fresh', inherited_from: null });
    expect(expectRefusal(() => gate(FROZEN, { kind: 'NONE' }), 'ACL0_LACKS_CLIENT_EXECUTE').hold).toBe(true);
  });
  it('NOT_FROZEN: the ledger ACL0 is accepted; the frozen set is refused; anything else needs an Owner rebaseline', () => {
    expect(gate([...ACL0].reverse(), ex('NOT_FROZEN'))).toMatchObject({ basis: 'ledger_acl0' });
    expectRefusal(() => gate(FROZEN, ex('NOT_FROZEN')), 'ACL0_IS_FROZEN_SET');
    expectRefusal(() => gate(FROZEN, ex('NOT_FROZEN'), { rebaseline: true }), 'ACL0_IS_FROZEN_SET');
    const changed = [...ACL0, t(C.SUBMIT_SIGNATURE, 'custom_reader')];
    expectRefusal(() => gate(changed, ex('NOT_FROZEN')), 'ACL0_NOT_IN_LEDGER');
    expect(gate(changed, ex('NOT_FROZEN'), { rebaseline: true })).toMatchObject({ basis: 'rebaseline', target_acl0: changed.map(C.normalizeAclTuple) });
    expectRefusal(() => gate([...FROZEN, t(C.SUBMIT_SIGNATURE, 'authenticated')], ex('NOT_FROZEN'), { rebaseline: true }), 'ACL0_LACKS_CLIENT_EXECUTE');
  });
  it('FROZEN / UNCERTAIN: the frozen set only with carry-forward (the LEDGER ACL0 becomes the target); a changed ACL is PRIOR_FROZEN_ACL_CHANGED', () => {
    for (const kind of ['FROZEN', 'UNCERTAIN']) {
      expect(gate([...FROZEN].reverse(), ex(kind), { carryForward: true })).toMatchObject({ basis: 'carried_forward', target_acl0: ACL0, inherited_from: 'attempt-001' });
      expectRefusal(() => gate(FROZEN, ex(kind)), 'PRIOR_ATTEMPT_FREEZE_UNRESOLVED');
      expectRefusal(() => gate(FROZEN, ex(kind), { rebaseline: true }), 'PRIOR_ATTEMPT_FREEZE_UNRESOLVED');
      expect(gate(ACL0, ex(kind), { carryForward: true })).toMatchObject({ basis: 'ledger_acl0' });
      const moved = [...FROZEN, t(C.APPROVE_SIGNATURE, 'service_role')];
      expectRefusal(() => gate(moved, ex(kind), { carryForward: true }), 'PRIOR_FROZEN_ACL_CHANGED');
      // a carried ACL0 that itself looks frozen is never a restoration target
      expectRefusal(() => gate(FROZEN, ex(kind, { acl0: FROZEN.slice(0, 1), frozen: FROZEN }), { carryForward: true }), 'ACL0_LACKS_CLIENT_EXECUTE');
    }
  });
});

describe('D-09 — the ledger is bound to one database, one evidence root and (for Production) the Owner anchor', () => {
  const database = { database: 'postgres', database_oid: '5', system_identifier: '7689639409083970448' };
  const anchor = { database, evidence_root_sha256: 'f'.repeat(64) };
  const ledger = { prior_attempts: 1, ledger_sha256: 'e'.repeat(64) };
  const p = (o: Record<string, unknown> = {}) => ({ attempt_id: 'attempt-001', t0: 'T0', ledger_anchor: anchor, ...o });
  it('PASSES the same database and root; an Owner anchor, when given, must match exactly', () => {
    expect(C.assertLedgerAnchor({ priorAttempts: [p()], anchor, ledger })).toEqual({ ...ledger, owner_anchored: false });
    expect(C.assertLedgerAnchor({ priorAttempts: [p({ ledger_anchor: { database: { system_identifier: database.system_identifier, database_oid: '5', database: 'postgres' }, evidence_root_sha256: 'f'.repeat(64) } })], anchor, ledger, expected: { prior_attempts: '1', ledger_sha256: 'E'.repeat(64) } }))
      .toEqual({ ...ledger, owner_anchored: true });
  });
  it('refuses another database, another evidence root, a missing anchor and a mismatching Owner anchor', () => {
    expectRefusal(() => C.assertLedgerAnchor({ priorAttempts: [p({ ledger_anchor: { ...anchor, database: { ...database, database_oid: '6' } } })], anchor, ledger }), 'LEDGER_DATABASE_MISMATCH');
    expectRefusal(() => C.assertLedgerAnchor({ priorAttempts: [p({ ledger_anchor: { ...anchor, evidence_root_sha256: 'a'.repeat(64) } })], anchor, ledger }), 'LEDGER_ROOT_MISMATCH');
    expectRefusal(() => C.assertLedgerAnchor({ priorAttempts: [p({ ledger_anchor: undefined })], anchor, ledger }), 'LEDGER_ANCHOR_MISSING');
    expect(C.assertLedgerAnchor({ priorAttempts: [p({ ledger_anchor: undefined, t0: undefined })], anchor, ledger }).prior_attempts).toBe(1);
    expectRefusal(() => C.assertLedgerAnchor({ priorAttempts: [], anchor: { database }, ledger }), 'LEDGER_ANCHOR_MISSING');
    expectRefusal(() => C.assertLedgerAnchor({ priorAttempts: [p()], anchor, ledger, expected: { prior_attempts: 0 } }), 'LEDGER_ANCHOR_MISMATCH');
    expectRefusal(() => C.assertLedgerAnchor({ priorAttempts: [p()], anchor, ledger, expected: { prior_attempts: 'many' } }), 'LEDGER_ANCHOR_MISMATCH');
    expectRefusal(() => C.assertLedgerAnchor({ priorAttempts: [p()], anchor, ledger, expected: { ledger_sha256: 'd'.repeat(64) } }), 'LEDGER_ANCHOR_MISMATCH');
  });
  it('Production REQUIRES the Owner-recorded anchor (a retry from a fresh, empty evidence root is otherwise invisible)', () => {
    expectRefusal(() => C.assertLedgerAnchor({ target: 'production', priorAttempts: [], anchor, ledger: { prior_attempts: 0, ledger_sha256: 'e'.repeat(64) } }), 'LEDGER_ANCHOR_REQUIRED');
    expectRefusal(() => C.assertLedgerAnchor({ target: 'production', priorAttempts: [], anchor, ledger, expected: { prior_attempts: 1 } }), 'LEDGER_ANCHOR_REQUIRED');
    expect(C.assertLedgerAnchor({ target: 'production', priorAttempts: [p()], anchor, ledger, expected: { prior_attempts: 1, ledger_sha256: 'e'.repeat(64) } }).owner_anchored).toBe(true);
  });
  it('the ledger digest input binds the database identity and every prior attempt manifest, in order', () => {
    const text = C.ledgerDigestInput({ database, priorEntries: [{ attempt_id: 'attempt-001-x', manifest_sha256: 'a'.repeat(64) }, { attempt_id: 'attempt-002-y', manifest_sha256: null }] });
    expect(text).toBe(`c5-activation-ledger v1\ndatabase {"database":"postgres","database_oid":"5","system_identifier":"7689639409083970448"}\n` +
      `attempt-001-x ${'a'.repeat(64)}\nattempt-002-y MANIFEST_UNREADABLE\n`);
  });
});

describe('SQL text — what the runbook actually executes', () => {
  it('the T0 snapshot is ONE statement carrying T0, S0, the widened A0, both ACLs, the census and the runner', () => {
    expect(Q.T0_SNAPSHOT_SQL).not.toContain(';');
    for (const needle of ["AS t0", 'AS s0', 'AS a0', 'AS acl0', 'AS reject_acl0', 'AS l0', 'runner_current_user', 'clock_timestamp()']) {
      expect(Q.T0_SNAPSHOT_SQL).toContain(needle);
    }
    for (const field of ["'plan_id'", "'organization_id'", "'revision_number'", "'approved_by'", "'approved_at'", "'updated_at'"]) {
      expect(Q.T0_SNAPSHOT_SQL).toContain(field);
    }
    expect(Q.T0_SNAPSHOT_SQL).toContain("pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner)))");
    expect(Q.T0_SNAPSHOT_SQL).toContain("'grantor'");
    expect(Q.T0_SNAPSHOT_SQL).toContain(C.REJECT_SIGNATURE);
    // D-02: the pre-C5 body fingerprints are part of the SAME statement, session-independent (no pg_get_functiondef rendering)
    expect(Q.T0_SNAPSHOT_SQL).toContain('AS fingerprints');
    for (const sig of C.FINGERPRINT_SIGNATURES) expect(Q.T0_SNAPSHOT_SQL).toContain(`'${sig}'`);
    expect(Q.T0_SNAPSHOT_SQL).toMatch(/md5\(jsonb_build_array\(p\.oid::text, p\.prosrc,/);
    expect(Q.M217_STATE_SQL).toContain('AS fingerprints');
  });
  it('D-02: the in-flight M217 check reads ShareLock-or-stronger locks on BOTH §1 relations (prepared transactions included), M217-only query text and hidden sessions', () => {
    expect(Q.M217_IN_FLIGHT_SQL).toContain('pg_catalog.pg_locks');
    expect(Q.M217_IN_FLIGHT_SQL).toContain("'public.central_needs_source_records'::regclass");
    expect(Q.M217_IN_FLIGHT_SQL).toContain("'public.central_needs_plan_revisions'::regclass");
    expect(Q.M217_IN_FLIGHT_SQL).toContain("l.mode IN ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')");
    expect(Q.M217_IN_FLIGHT_SQL).toContain('l.pid IS DISTINCT FROM pg_catalog.pg_backend_pid()');
    expect(Q.M217_IN_FLIGHT_SQL).toContain("a.query = '<insufficient privilege>'");
    for (const token of C.M217_IN_FLIGHT_TOKENS) expect(Q.M217_IN_FLIGHT_SQL).toContain(`position('${token}' IN a.query) > 0`);
    expect(Q.DATABASE_IDENTITY_SQL).toContain("has_function_privilege('pg_catalog.pg_control_system()', 'EXECUTE')");
  });
  it('the drain is EXACTLY the contract §2.3 statement, plus a visibility guard with NO backend_type filter, plus prepared transactions', () => {
    expect(Q.DRAIN_PRE_F0_SQL).toBe(`SELECT pid, usename, application_name, state, xact_start, query_start
FROM pg_stat_activity
WHERE datname = current_database()
  AND backend_type = 'client backend'
  AND pid <> pg_backend_pid()
  AND xact_start IS NOT NULL
  AND xact_start < $1::timestamptz
ORDER BY xact_start, pid`);
    expect(Q.DRAIN_HIDDEN_SESSIONS_SQL).toContain("query = '<insufficient privilege>'");
    expect(Q.DRAIN_HIDDEN_SESSIONS_SQL).not.toContain('backend_type');
    expect(Q.DRAIN_PREPARED_SQL).toContain('pg_prepared_xacts');
    expect(Q.DRAIN_PREPARED_SQL).toContain('current_database()');
  });
  it('the runner is attested for (rolsuper OR rolbypassrls) AND (rolsuper OR pg_read_all_stats)', () => {
    for (const needle of ['rolsuper', 'rolbypassrls', "pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')", 'session_user']) {
      expect(Q.RUNNER_ATTRIBUTES_SQL).toContain(needle);
    }
  });
  it('D-12: no statement in the SQL module writes, except the ONE governed reject RPC call; history is read as TEXT, never cast', () => {
    for (const [name, sql] of Object.entries(Q)) {
      if (typeof sql !== 'string' || name === 'DCL_LOCK_TIMEOUT_SQL') continue;
      expect(sql, name).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|GRANT\s+\w+\s+ON|REVOKE\s+\w+\s+ON|CREATE\s|DROP\s|ALTER\s)/i);
    }
    // the only statement that CALLS a lifecycle RPC (a mutation performed by a function) is the governed reject
    const callers = Object.entries(Q).filter(([, sql]) => typeof sql === 'string' && /phoenix_central_needs_(submit|approve|reject)_revision\s*\(\s*\$/.test(sql)).map(([n]) => n);
    expect(callers).toEqual(['REJECT_RPC_SQL']);
    expect(Q.REJECT_RPC_SQL).toBe('SELECT public.phoenix_central_needs_reject_revision($1, $2) AS result');
    expect(readFileSync(join(REPO_ROOT, 'tools', 'phoenix-demo', 'c5-activation-sql.mjs'), 'utf8')).not.toMatch(/READ-ONLY: every statement in this module is a plain SELECT/);
    expect(Q.HISTORY_SQL).toContain('version::text');
    expect(Q.HISTORY_SQL).not.toMatch(/version::int/);
    expect(Q.DCL_LOCK_TIMEOUT_SQL).toBe("SET LOCAL lock_timeout = '5s'");
  });
  it('Proof B and the resolution evidence read xmin for the physical same-transaction check', () => {
    expect(Q.PROOF_B_SQL).toContain('.xmin::text AS xmin');
    expect(Q.PROOF_B_SQL).toContain("payload->>'approval_gate_txid'");
    expect(Q.RESOLUTION_EVIDENCE_SQL).toContain('r.xmin::text AS revision_xmin');
    expect(Q.RESOLUTION_EVIDENCE_SQL).toContain("'xmin', a.xmin::text");
  });
  it('H13: the chronology predicate covers shared created_at AND queued pre-M217 overrides at/after T0, on DRAFT revisions only', () => {
    expect(Q.CHRONOLOGY_AMBIGUITY_SQL).toContain("r.status = 'draft'");
    expect(Q.CHRONOLOGY_AMBIGUITY_SQL).toContain('same_ts >= 2');
    expect(Q.CHRONOLOGY_AMBIGUITY_SQL).toContain('o.created_at >= $1::timestamptz AND o.created_at < $2::timestamptz');
    expect(Q.CHRONOLOGY_AMBIGUITY_SQL).toContain('o.n >= 2');
    expect(Q.NON_HEAD_PIN_AUDIT_SQL).toContain('ORDER BY o.source_record_id, o.created_at DESC, o.id DESC');
    expect(Q.NON_HEAD_PIN_AUDIT_SQL).toContain("IN ('ambiguous_numeric_text', 'not_numeric') AS required_pin");
    expect(Q.DRAFT_LINEAGE_AUDIT_SQL).toContain('_phoenix_central_needs_quantity_lineage_violation_v1(ns.id)');
    expect(Q.DRAFT_INVALID_EVIDENCE_SQL).toContain("s.status = 'completed'");
  });
});

describe('runbook CLI guards that need no database', () => {
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'c5-unit-')); scratch.push(d); return d; };
  const env = (o: Record<string, string> = {}) => ({ PHOENIX_C5_ACTIVATION_DATABASE_URL: 'postgresql://u:pw@db.example.com:5432/x', ...o });
  it('refuses a non-loopback URL, Production without the phrase, and an unknown phase — before connecting to anything', async () => {
    const dir = tmp();
    await expectAsyncRefusal(main(['--phase=preflight', `--evidence-dir=${dir}`], env()), 'TARGET_NOT_LOOPBACK');
    await expectAsyncRefusal(main(['--phase=preflight', `--evidence-dir=${dir}`, '--target=production'],
      env({ PHOENIX_PRODUCTION_DATABASE_URL: 'postgresql://postgres.eyrzxgfkvqybjdgyphap:pw@aws-0.pooler.supabase.com:5432/postgres' })), 'PRODUCTION_NOT_AUTHORIZED');
    await expectAsyncRefusal(main(['--phase=apply', `--evidence-dir=${dir}`], env()), 'PHASE_UNKNOWN');
    await expectAsyncRefusal(main(['phase=preflight'], env()), 'ARGUMENT_UNRECOGNIZED');
    // D-06 through the CLI: a loopback URL whose query redirects the host
    await expectAsyncRefusal(main(['--phase=preflight', `--evidence-dir=${dir}`],
      env({ PHOENIX_C5_ACTIVATION_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:1/x?host=db.example.com' })), 'TARGET_NOT_LOOPBACK');
  });
  it('D-11 / D-02: a bare --reviewed-cascade and a malformed executor state are refused before connecting (the port below has nothing listening)', async () => {
    const dir = tmp();
    const loop = env({ PHOENIX_C5_ACTIVATION_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:1/x' });
    await expectAsyncRefusal(main(['--phase=preflight', `--evidence-dir=${dir}`, '--reviewed-cascade'], loop), 'CASCADE_OWNER_REFERENCE_REQUIRED');
    await expectAsyncRefusal(main(['--phase=post-apply', `--evidence-dir=${dir}`, '--executor-conclusion=done'], loop), 'EXECUTOR_RUN_MALFORMED');
    await expectAsyncRefusal(main(['--phase=post-apply', `--evidence-dir=${dir}`, '--executor-run-id=12'], loop), 'EXECUTOR_RUN_MALFORMED');
    await expectAsyncRefusal(main(['--phase=stop', `--evidence-dir=${dir}`, '--executor-conclusion=failure'], loop), 'EXECUTOR_RUN_MALFORMED');
  });
  it('refuses an evidence directory inside the repository', () => {
    expectRefusal(() => new EvidenceStore(join(REPO_ROOT, 'evidence')), 'EVIDENCE_DIR_INSIDE_REPO');
  });
  it('seals every write in a sha256sum manifest, detects tampering, and refuses to write a connection string', () => {
    const store = new EvidenceStore(tmp());
    const state: Record<string, unknown> = { attempt_id: 'attempt-001-x', completed: [] };
    store.saveState(state);
    store.record(state, 'probe', { value: 1 });
    expect(store.verifyManifest('attempt-001-x')).toBe(true);
    const manifest = readFileSync(join(store.dir('attempt-001-x'), 'SHA256SUMS.txt'), 'utf8');
    expect(manifest).toMatch(/^[0-9a-f]{64} \*\.\/01-probe\.json$/m);
    expect(manifest).toMatch(/^[0-9a-f]{64} \*\.\/attempt-state\.json$/m);
    writeFileSync(join(store.dir('attempt-001-x'), '01-probe.json'), '{"value":2}\n');
    expect(store.verifyManifest('attempt-001-x')).toBe(false);
    expectRefusal(() => store.record(state, 'leak', { url: 'postgresql://u:pw@h/db' }), 'EVIDENCE_CONTAINS_SECRET_PATTERN');
  });
});
