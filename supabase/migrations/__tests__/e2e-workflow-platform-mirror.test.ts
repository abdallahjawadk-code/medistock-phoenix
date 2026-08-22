/**
 * E2E-WORKFLOW-PLATFORM-MIRROR — the guard that keeps
 * `.github/workflows/e2e-authenticated.yml` in step with the canonical rig.
 *
 * WHY THIS EXISTS. That workflow hand-mirrors two things the disposable rig
 * does in code: the pre-001 platform bootstrap (tools/pg-rig/bootstrap.sql)
 * and the migration replay policy (tools/pg-rig/rig.mjs). Nothing enforced
 * that the mirrors stayed true, and both silently went stale during H Unit 2:
 *
 *   * the workflow moved migration 085 out of the checkout, citing the rig's
 *     since-retired PREPARED_ONLY_SKIP — but Production APPLIED 085, and the
 *     rig now replays it with a session-scoped attestation; and
 *   * the workflow's pre-001 bootstrap mirrored only the TABLE and SEQUENCE
 *     default privileges, omitting the two H-23 `service_role` platform facts,
 *     so no pre-migration-109 function inherited `service_role EXECUTE`.
 *
 * The result was a CI failure in which migration 194's `service_role`
 * precondition correctly fail-closed against an environment that did not
 * reproduce the required Production baseline. The migration was right; the
 * environment mirror was wrong.
 *
 * These assertions compare SEMANTIC MARKERS and exact SQL constants — not
 * prose — so ordinary comment edits do not break them, while a real
 * divergence does. Static only: no database, no network.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const WORKFLOW_PATH = '.github/workflows/e2e-authenticated.yml';
const WORKFLOW = readFileSync(join(ROOT, WORKFLOW_PATH), 'utf8');
const BOOTSTRAP = readFileSync(join(ROOT, 'tools/pg-rig/bootstrap.sql'), 'utf8');
const RIG = readFileSync(join(ROOT, 'tools/pg-rig/rig.mjs'), 'utf8');

const M085 = '085_phoenix_revoke_manual_availability_writers.sql';
const M085_SHA256 = 'b69326713c273f468bd53b8d66430ac907aff54f27c06ab9149427833eb20ab0';

/**
 * The workflow with commentary removed — YAML `#` lines and the JS `//` lines
 * inside its inline node scripts. Negative assertions run against THIS, never
 * the raw file: the workflow legitimately quotes the shapes it is guarding
 * against (e.g. 085's own operator-guidance `SET phoenix.availability_cutover_
 * attested = ''true''`), and a raw scan mistakes that documentation for the
 * defect it describes.
 */
const executableWorkflow = (): string =>
  WORKFLOW
    .replace(/^\s*#.*$/gm, '')          // YAML comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // JS line comments, sparing URLs
const EXEC_WORKFLOW = executableWorkflow();

/** The exact platform statements the rig's bootstrap installs pre-001. */
const PLATFORM_BASELINE_STATEMENTS = [
  'GRANT CREATE ON SCHEMA public TO service_role;',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO authenticated, service_role;',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role;',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;',
] as const;

describe('E2E workflow · migration 085 replay policy', () => {
  it('does NOT move, delete or otherwise skip migration 085', () => {
    // The exact stale mechanism, by shape rather than by phrasing.
    expect(WORKFLOW).not.toMatch(new RegExp(String.raw`mv\s+supabase/migrations/${M085}`));
    expect(WORKFLOW).not.toMatch(new RegExp(String.raw`rm\s+[^\n]*${M085}`));
    expect(WORKFLOW).not.toContain('/tmp/prepared-only-skip');
  });

  it('carries no LIVE PREPARED_ONLY_SKIP mirror — only a retraction of it', () => {
    // The rig retired that symbol entirely, so it must be gone from the code.
    expect(RIG, 'rig.mjs must no longer define a skip set').not.toContain('PREPARED_ONLY_SKIP');

    // The workflow may still NAME it, but only while explaining that it is
    // retired — the failed-round history is deliberately kept, not scrubbed.
    // What must never come back is it being presented as current behaviour.
    //
    // Checked against the UNWRAPPED comment text: the retirement marker and
    // the symbol routinely land on different physical lines once a comment
    // wraps, so a line-by-line check would fail on correct prose.
    const mentionLines = WORKFLOW.split(/\r?\n/).filter((l) => l.includes('PREPARED_ONLY_SKIP'));
    for (const line of mentionLines) {
      expect(line.trimStart(), `PREPARED_ONLY_SKIP must only appear in a comment: ${line}`).toMatch(/^#/);
    }
    const unwrapped = WORKFLOW.replace(/^\s*#\s?/gm, ' ').replace(/\s+/g, ' ');
    for (const m of unwrapped.matchAll(/PREPARED_ONLY_SKIP/g)) {
      const before = unwrapped.slice(Math.max(0, m.index - 120), m.index);
      expect(before, `PREPARED_ONLY_SKIP must be marked retired, not current (context: …${before.slice(-90)})`)
        .toMatch(/since-retired|no longer|USED to|retired|former|previously/i);
    }
  });

  it('prepares 085 with an ephemeral attestation, guarded by its exact SHA-256', () => {
    expect(WORKFLOW).toContain('M085-ATTESTED-EPHEMERAL-PREPARATION');
    expect(WORKFLOW).toContain(M085_SHA256);
    expect(WORKFLOW).toContain("SET LOCAL phoenix.availability_cutover_attested = 'true';");
  });

  it('the attestation is transaction-local, so it cannot leak into 086+', () => {
    // SET LOCAL, never a session-wide SET, and never a persisted ALTER ... SET.
    expect(WORKFLOW).toMatch(/SET LOCAL phoenix\.availability_cutover_attested/);
    // Checked on executable content only — the workflow's own comments quote
    // 085's session-scoped operator guidance verbatim while explaining it.
    // Non-vacuity: the executable view must still carry the real statement,
    // otherwise the negative assertion below would pass on an empty haystack.
    expect(EXEC_WORKFLOW).toContain("SET LOCAL phoenix.availability_cutover_attested = 'true';");
    expect(EXEC_WORKFLOW).not.toMatch(/(?<!LOCAL )\bSET phoenix\.availability_cutover_attested/);
    expect(EXEC_WORKFLOW).not.toMatch(/ALTER (DATABASE|ROLE|SYSTEM)[^\n]*availability_cutover_attested/i);
  });

  it('the ephemeral transform is fail-closed on structural drift', () => {
    // A blind text substitution is exactly what must not happen here.
    expect(WORKFLOW).toMatch(/expected exactly one standalone "BEGIN;"/);
    expect(WORKFLOW).toMatch(/attestation inserted \$\{inserted\} times, expected exactly 1/);
    expect(WORKFLOW).toMatch(/SHA-256 mismatch/);
  });

  it('never rewrites the committed 085 file — only the ephemeral checkout', () => {
    expect(WORKFLOW).toMatch(/never committed|ephemeral (runner'?s )?checkout/i);
  });
});

describe('E2E workflow · platform baseline mirror', () => {
  it('mirrors every platform statement the canonical bootstrap installs', () => {
    for (const stmt of PLATFORM_BASELINE_STATEMENTS) {
      expect(BOOTSTRAP, `bootstrap.sql must contain: ${stmt}`).toContain(stmt);
      expect(WORKFLOW, `E2E workflow must mirror: ${stmt}`).toContain(stmt);
    }
  });

  it('specifically carries the two H-23 service_role facts the mirror once omitted', () => {
    expect(WORKFLOW).toContain('GRANT CREATE ON SCHEMA public TO service_role;');
    expect(WORKFLOW).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;');
  });

  it('is tagged so the coupling is discoverable from the workflow itself', () => {
    expect(WORKFLOW).toContain('E2E-PLATFORM-BASELINE-MIRROR');
    expect(WORKFLOW).toMatch(/keep in sync with tools\/pg-rig\/bootstrap\.sql/i);
  });

  it('installs the baseline BEFORE migration 001 creates any object', () => {
    const prependIdx = WORKFLOW.indexOf('E2E-PLATFORM-BASELINE-MIRROR');
    const catIdx = WORKFLOW.indexOf('cat supabase/migrations/001_phoenix_core_schema.sql');
    expect(prependIdx).toBeGreaterThan(-1);
    expect(catIdx).toBeGreaterThan(prependIdx);
  });
});

describe('E2E workflow · post-start authorization proof', () => {
  it('asserts the M085 boundary and the M194 surface after startup', () => {
    expect(WORKFLOW).toContain('M085-M194-E2E-SECURITY-PROOF');
    expect(WORKFLOW).toMatch(/has_function_privilege\('authenticated'/);
    expect(WORKFLOW).toMatch(/has_function_privilege\('service_role'/);
    expect(WORKFLOW).toContain("'distribution_points INSERT', 'distribution_points UPDATE'");
    expect(WORKFLOW).toContain("'organizations INSERT', 'organizations UPDATE'");
    expect(WORKFLOW).toMatch(/MAINTAIN/);
  });

  it('asserts the attestation did not leak, on a fresh connection', () => {
    expect(WORKFLOW).toMatch(/current_setting\('phoenix\.availability_cutover_attested', true\)/);
    expect(WORKFLOW).toMatch(/attestation leaked beyond its transaction/);
  });

  it('runs the proof BEFORE the fixtures are seeded', () => {
    const proofIdx = WORKFLOW.indexOf('M085-M194-E2E-SECURITY-PROOF');
    const seedIdx = WORKFLOW.indexOf('Seed disposable fixtures');
    expect(proofIdx).toBeGreaterThan(-1);
    expect(seedIdx).toBeGreaterThan(proofIdx);
  });
});

describe('E2E workflow · stays disposable and Production-free', () => {
  it('uses only the local disposable Supabase stack', () => {
    expect(WORKFLOW).toContain('supabase start');
    expect(WORKFLOW).toMatch(/DB_URL|sb-db-url/);
  });

  it('introduces no Production project reference, credential or mutation', () => {
    expect(WORKFLOW).not.toContain('eyrzxgfkvqybjdgyphap');
    expect(WORKFLOW).not.toMatch(/pooler\.supabase\.com/);
    expect(WORKFLOW).not.toMatch(/PHOENIX_DATABASE_URL/);
    expect(WORKFLOW).not.toMatch(/supabase\s+link/);
    expect(WORKFLOW).not.toMatch(/supabase\s+db\s+push/);
    expect(WORKFLOW).not.toMatch(/apply_migration/);
    // Secrets are permitted for nothing in this job; it is fixed local-dev keys only.
    expect(WORKFLOW).not.toMatch(/secrets\.[A-Z_]*(PROD|PRODUCTION|SERVICE_ROLE|DB_PASSWORD)/);
  });

  it('still reaches migration 194, not a truncated ceiling', () => {
    // `supabase start` applies 001->latest; the ceiling guard must not have
    // been narrowed while fixing the mirror.
    expect(WORKFLOW).toMatch(/applies supabase\/migrations\/001->latest/);
  });
});
