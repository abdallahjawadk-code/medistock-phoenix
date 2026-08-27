/**
 * STAGE I / I-6 — CI ACCEPTANCE EMISSION CONTRACT.
 *
 * Three gaps closed here, and this file is what keeps them closed.
 *
 * 1. THE REQUIRED-CHECK DEADLOCK.
 *    I-1B makes "Authenticated browser acceptance (disposable local Supabase)"
 *    a REQUIRED status check on master. GitHub blocks a pull request whose
 *    required context never arrives, and a path-filtered workflow does not run
 *    at all for a non-matching PR — so the context is never reported and the PR
 *    sits permanently waiting. Rulesets have no conditional or path-scoped form
 *    of required_status_checks. Measured, not assumed: against the ten-path
 *    matrix this workflow briefly carried, 5 of 15 open PRs matched nothing and
 *    would have deadlocked, and #153/#154 had already merged with the context
 *    absent. The workflow therefore carries NO `paths:` filter, and this file
 *    fails if one is reintroduced.
 *
 * 2. AUTHENTICATED ACCEPTANCE DID NOT EMIT FOR EVERYTHING IT PROVES.
 *    Before I-6 its trigger named five source paths, so executor and
 *    reconciler PRs merged without it. It now runs for every master PR.
 *
 * 3. THE WINDOWS OPS ASSERTIONS NEVER RAN.
 *    ops-purge-runner-compatibility.test.ts guards the owner-run PowerShell
 *    release engine. Eight of its assertions need Windows PowerShell 5.1;
 *    every ci.yml runner is ubuntu-24.04. Seven were honestly skipped and one
 *    `return`ed early off Windows — reported by vitest as a PASS that asserted
 *    nothing. This file forbids that shape and pins the Windows job that now
 *    executes them for real.
 *
 * Text-only. No database, no network, no CLI.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const WF = join(ROOT, '.github', 'workflows');

const E2E_YML = readFileSync(join(WF, 'e2e-authenticated.yml'), 'utf8');
const CI_YML = readFileSync(join(WF, 'ci.yml'), 'utf8');
const WIN_YML_PATH = join(WF, 'ops-windows-acceptance.yml');
const OPS_TEST = readFileSync(
  join(ROOT, 'supabase', 'migrations', '__tests__', 'ops-purge-runner-compatibility.test.ts'),
  'utf8',
);

/** Statement text with comments stripped, so prose can never satisfy a check. */
const code = (s: string) => s.replace(/^\s*#.*$/gm, ' ');

/** The exact context string I-1B requires on master. */
const REQUIRED_CONTEXT = 'Authenticated browser acceptance (disposable local Supabase)';

describe('authenticated acceptance — required-check compatibility', () => {
  it('emits the EXACT context string the master ruleset requires', () => {
    expect(E2E_YML).toContain(`name: ${REQUIRED_CONTEXT}`);
  });

  it('carries NO pull_request paths filter — a required check must be unconditional', () => {
    // The single assertion that prevents the I-1B deadlock. A `paths:` (or
    // `paths-ignore:`) filter means the workflow does not run for a
    // non-matching PR, the required context is never reported, and the PR is
    // blocked forever. Rulesets cannot express a conditional requirement.
  const onBlock = E2E_YML.slice(E2E_YML.indexOf('workflow_dispatch'), E2E_YML.indexOf('permissions:'));
    expect(onBlock).not.toMatch(/^\s*paths\s*:/m);
    expect(onBlock).not.toMatch(/^\s*paths-ignore\s*:/m);
  });

  it('targets master, the ref the ruleset guards', () => {
  const onBlock = E2E_YML.slice(E2E_YML.indexOf('workflow_dispatch'), E2E_YML.indexOf('permissions:'));
    expect(onBlock).toContain('branches:');
    expect(onBlock).toMatch(/-\s*master/);
  });

  it('runs the REAL browser acceptance, not a placeholder', () => {
    expect(code(E2E_YML)).toContain('node tools/e2e-acceptance/run.mjs');
    // …against a real built bundle served over HTTP, with a real local stack.
    expect(code(E2E_YML)).toContain('npm run build');
    expect(code(E2E_YML)).toContain('supabase start');
  });

  it('never soft-passes: no continue-on-error and no disabled job', () => {
    expect(code(E2E_YML)).not.toMatch(/continue-on-error\s*:\s*true/);
    expect(code(E2E_YML)).not.toMatch(/if\s*:\s*false/);
  });

  it('gates nothing behind a step-level condition that could skip the acceptance', () => {
    // The acceptance step itself must be unconditional; a step-level `if:`
    // would let the job report SUCCESS without driving the browser.
    const i = E2E_YML.indexOf('node tools/e2e-acceptance/run.mjs');
    const stepStart = E2E_YML.lastIndexOf('      - name:', i);
    expect(E2E_YML.slice(stepStart, i)).not.toMatch(/^\s*if\s*:/m);
  });
});

describe('pg-rig TLS mixed-history acceptance stays in ci.yml', () => {
  // The executor surfaces (tools/phoenix-demo/**, apply-production-migration.yml,
  // ci.yml) are deliberately NOT authenticated-E2E triggers: that job never
  // exercises the executor, so firing it there would add a green check proving
  // nothing. They are gated here and by the executor contract test instead.
  it('still runs the disposable TLS-only mixed-history acceptance', () => {
    expect(code(CI_YML)).toContain('node tools/phoenix-demo/mixed-history-acceptance.mjs');
  });

  it('still proves the acceptance database refuses plaintext TCP', () => {
    expect(CI_YML).toContain('Prove the acceptance database refuses plaintext TCP');
    expect(code(CI_YML)).toContain('sslmode=disable');
  });

  it('still replays the predecessor chain before pushing the newest migration', () => {
    expect(code(CI_YML)).toContain('node tools/pg-rig/apply.mjs 196');
  });

  it('still pins the Supabase CLI rather than tracking latest', () => {
    expect(code(CI_YML)).toContain('version: 2.115.0');
    expect(code(CI_YML)).not.toMatch(/version:\s*latest/);
  });

  it('never soft-passes', () => {
    expect(code(CI_YML)).not.toMatch(/continue-on-error\s*:\s*true/);
  });
});

describe('Windows ops release-engine coverage', () => {
  it('a Windows acceptance workflow exists', () => {
    expect(existsSync(WIN_YML_PATH), 'ops-windows-acceptance.yml is missing').toBe(true);
  });

  it('runs on a real Windows runner and exercises the ops-purge contract file', () => {
    const win = readFileSync(WIN_YML_PATH, 'utf8');
    expect(win).toContain('runs-on: windows-latest');
    expect(code(win)).toContain('supabase/migrations/__tests__/ops-purge-runner-compatibility.test.ts');
  });

  it('proves Windows PowerShell 5.1 is present BEFORE trusting the run', () => {
    // Without this, a runner image without 5.1 would silently revert every
    // Windows-only assertion to "skipped" and the job would go green.
    const win = readFileSync(WIN_YML_PATH, 'utf8');
    expect(code(win)).toContain('WindowsPowerShell/v1.0/powershell.exe');
    expect(win).toMatch(/would silently skip|silently revert/);
  });

  it('fails the job if any assertion was skipped rather than executed', () => {
    const win = readFileSync(WIN_YML_PATH, 'utf8');
    expect(code(win)).toContain('--reporter=json');
    expect(win).toMatch(/skipped > 0/);
    expect(win).toMatch(/were SKIPPED on a Windows runner/);
  });

  it('never soft-passes', () => {
    const win = readFileSync(WIN_YML_PATH, 'utf8');
    expect(code(win)).not.toMatch(/continue-on-error\s*:\s*true/);
    expect(code(win)).not.toMatch(/if\s*:\s*false/);
  });
});

describe('the ops-purge contract file reports honestly off Windows', () => {
  it('contains NO early-return platform guard — those report as a false pass', () => {
    // `if (process.platform !== 'win32') return;` makes vitest record a PASSED
    // test that asserted nothing. it.runIf(canRun) records SKIPPED instead, so
    // "not attempted" stays distinguishable from "proven" in the CI summary.
    expect(OPS_TEST).not.toMatch(/process\.platform\s*!==\s*'win32'[^\n]*\breturn\b/);
  });

  it('gates its Windows-only assertions with it.runIf(canRun)', () => {
    const runIfs = OPS_TEST.split('\n').filter((l) => l.includes('it.runIf(canRun)(')).length;
    expect(runIfs).toBeGreaterThanOrEqual(8);
  });

  it('keeps the platform-neutral byte guards ungated, so Linux still proves them', () => {
    // These two are the cheap half and must NOT become Windows-only.
    expect(OPS_TEST).toContain("it('every ops PowerShell file is pure ASCII'");
    expect(OPS_TEST).toContain("it('contains no character PowerShell would treat as a smart-quote delimiter'");
  });
});

/**
 * THE DISPOSABLE-PLATFORM AUTHORIZATION BASELINE.
 *
 * The local Supabase CLI provisions public-schema default ACLs that neither
 * Production nor tools/pg-rig/bootstrap.sql carries. Measured on a pristine
 * stack with ZERO Phoenix migrations (CLI 2.116.0 / postgres 17.6.1.165):
 *
 *   postgres | public | table    | anon | arwdDxtm
 *   postgres | public | FUNCTION | {postgres, anon, authenticated, service_role} = EXECUTE
 *
 * Left un-normalized, each one takes the replay down at a different migration,
 * both fail-closed and both proven in a disposable full replay:
 *   * anon FUNCTION EXECUTE          -> 045 aborts P0004
 *   * authenticated FUNCTION EXECUTE -> 109 aborts P0004
 *   * anon TABLE SELECT (etc.)       -> 191 aborts P0001
 *
 * These assertions pin the SHAPE of the remediation, not merely its presence:
 * revoke-only, exact owner, exact schema, exact principals, exact privileges,
 * and service_role never stripped. A future "simplification" to REVOKE ALL, or
 * dropping a principal, or widening a grant, fails here rather than in a
 * 90-second CI job — or, worse, silently.
 */
describe('E2E disposable-platform default-ACL normalization', () => {
  /** The exact statements the pre-001 bootstrap emits, as executable echo lines. */
  const TABLE_REVOKE =
    'echo "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE '
    + 'INSERT, SELECT, UPDATE, DELETE, MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLES FROM anon;"';
  const FUNCTION_REVOKE =
    'echo "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE '
    + 'EXECUTE ON FUNCTIONS FROM anon, authenticated;"';
  const SERVICE_ROLE_FUNCTION_GRANT =
    'echo "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;"';

  it('revokes the FUNCTION default EXECUTE from anon and authenticated', () => {
    // Emitted as an echo line, so a comment describing it cannot satisfy this.
    expect(E2E_YML).toContain(FUNCTION_REVOKE);
  });

  it('scopes the FUNCTION revoke exactly: owner postgres, schema public, EXECUTE only', () => {
    const stmt = FUNCTION_REVOKE;
    expect(stmt).toContain('FOR ROLE postgres');
    expect(stmt).toContain('IN SCHEMA public');
    expect(stmt).toContain('REVOKE EXECUTE ON FUNCTIONS');
    // Never a blanket revoke, and never aimed at service_role.
    expect(stmt).not.toContain('REVOKE ALL');
    expect(stmt).not.toContain('service_role');
  });

  it('revokes the full measured anon TABLE privilege set, not just the four legacy ones', () => {
    // The four-privilege form left anon holding INSERT/SELECT/UPDATE/DELETE on
    // every pre-109 table, which migration 191 correctly refuses.
    expect(E2E_YML).toContain(TABLE_REVOKE);
    for (const priv of ['INSERT', 'SELECT', 'UPDATE', 'DELETE', 'MAINTAIN', 'REFERENCES', 'TRIGGER', 'TRUNCATE']) {
      expect(TABLE_REVOKE).toContain(priv);
    }
    expect(TABLE_REVOKE).toContain('FROM anon;');
    expect(TABLE_REVOKE).not.toContain('REVOKE ALL');
  });

  it('keeps the service_role FUNCTION EXECUTE default (H-23) intact', () => {
    // The normalization must not disturb service_role's platform baseline;
    // migration 109's own VERIFY also asserts service_role keeps it.
    expect(E2E_YML).toContain(SERVICE_ROLE_FUNCTION_GRANT);
  });

  it('never revokes anything from service_role in the pre-001 bootstrap', () => {
    const revokes = E2E_YML.split('\n').filter((l) => l.includes('echo "ALTER DEFAULT PRIVILEGES') && l.includes('REVOKE'));
    expect(revokes.length).toBeGreaterThanOrEqual(2);
    for (const line of revokes) expect(line).not.toContain('service_role');
  });

  it('keeps the table and sequence baseline mirror and the schema CREATE grant unchanged', () => {
    // Normalization is additive-revoke only: nothing already established here
    // may be dropped, and no grant may be widened.
    expect(E2E_YML).toContain('echo "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO authenticated, service_role;"');
    expect(E2E_YML).toContain('echo "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role;"');
    expect(E2E_YML).toContain('echo "GRANT CREATE ON SCHEMA public TO service_role;"');
    // anon/authenticated must never be handed CREATE on public.
    expect(E2E_YML).not.toContain('GRANT CREATE ON SCHEMA public TO anon');
    expect(E2E_YML).not.toContain('GRANT CREATE ON SCHEMA public TO authenticated');
  });

  it('normalizes the PLATFORM before 001, never Phoenix objects afterwards', () => {
    // The whole point: no per-function REVOKE bolted on after creation, and the
    // committed migration files stay immutable.
    expect(code(E2E_YML)).toContain('cat supabase/migrations/001_phoenix_core_schema.sql');
    expect(E2E_YML).not.toContain('REVOKE EXECUTE ON FUNCTION public.phoenix_update_my_whatsapp_phone');
  });
});
