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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shimSql } from '../../../tools/pg-rig/rig.mjs';

const ROOT = join(__dirname, '../../../');
const WORKFLOW_PATH = '.github/workflows/e2e-authenticated.yml';
const WORKFLOW = readFileSync(join(ROOT, WORKFLOW_PATH), 'utf8');
const BOOTSTRAP = readFileSync(join(ROOT, 'tools/pg-rig/bootstrap.sql'), 'utf8');
const RIG = readFileSync(join(ROOT, 'tools/pg-rig/rig.mjs'), 'utf8');

const M085 = '085_phoenix_revoke_manual_availability_writers.sql';
const M085_SHA256 = 'b69326713c273f468bd53b8d66430ac907aff54f27c06ab9149427833eb20ab0';
const M182 = '182_phoenix_health_center_facility_scoped_rbac.sql';
const M182_PATH = join(ROOT, 'supabase/migrations', M182);
const M182_RAW = readFileSync(M182_PATH, 'utf8');
const M182_NORMALIZED = shimSql(M182, M182_RAW);
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const M182_FUNCTIONS = [
  {
    signature: 'CREATE OR REPLACE FUNCTION public.get_effective_permissions(p_profile_id uuid)',
    rawHash: 'ffaee56895dcd70fca9c7235984b526b5c17cc6f4673c8c01223c23bf46f0510',
    productionHash: 'c7c67a94feaef3e8dd7efe8b86db32e93ab949418f18dafc90bc91a3936f3406',
  },
  {
    signature: 'CREATE OR REPLACE FUNCTION public.phoenix_profile_has_permission(p_profile_id uuid, p_key text)',
    rawHash: '73f1faf21d3d6990237c65f4def57a45ecf9459e8952f5d395d334e8a71e0d64',
    productionHash: '7fb2f8b311ab181b0189fb3ec6e13f2b068bc3ec588343a56be8c4df672f5188',
  },
] as const;

function functionBody(sql: string, signature: string): string {
  const signatureStart = sql.indexOf(signature);
  expect(signatureStart, signature).toBeGreaterThanOrEqual(0);
  expect(sql.indexOf(signature, signatureStart + signature.length), signature).toBe(-1);
  const open = sql.indexOf('AS $function$', signatureStart);
  const close = sql.indexOf('$function$;', open + 'AS $function$'.length);
  expect(open, signature).toBeGreaterThanOrEqual(0);
  expect(close, signature).toBeGreaterThan(open);
  return sql.slice(open + 'AS $function$'.length, close);
}

function maskM182TargetBodies(sql: string): string {
  let out = sql;
  for (const { signature } of M182_FUNCTIONS) {
    const body = functionBody(out, signature);
    out = out.replace(body, `\n<M182_REPLAY_BODY:${signature}>\n`);
  }
  return out;
}

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

describe('M182 · Production-recorded function-body replay parity', () => {
  it('pins the immutable repository source and both known source body forms', () => {
    expect(sha256(M182_RAW)).toBe('5915832037c6ca08c2d873a10eb4896884abe72667f4b7e71c27768572734fb0');
    for (const contract of M182_FUNCTIONS) {
      expect(sha256(functionBody(M182_RAW, contract.signature)), contract.signature)
        .toBe(contract.rawHash);
      expect(sha256(functionBody(M182_NORMALIZED, contract.signature)), contract.signature)
        .toBe(contract.productionHash);
    }
  });

  it('normalizes exactly the two body representations and no other M182 byte', () => {
    expect(M182_NORMALIZED).not.toBe(M182_RAW);
    expect(maskM182TargetBodies(M182_NORMALIZED)).toBe(maskM182TargetBodies(M182_RAW));
  });

  it('fails closed on historical source drift instead of guessing a transform', () => {
    expect(() => shimSql(M182, `${M182_RAW}\n`)).toThrow(/immutable source SHA-256 mismatch/);
    expect(shimSql('181_unrelated.sql', M182_RAW)).toBe(M182_RAW);
  });

  it('the E2E workflow invokes the canonical helper before local Supabase starts', () => {
    const marker = WORKFLOW.indexOf('M182-PRODUCTION-BODY-REPLAY-NORMALIZATION');
    const start = WORKFLOW.indexOf('- name: Start local Supabase');
    expect(marker).toBeGreaterThan(-1);
    expect(WORKFLOW).toContain("import { shimSql } from './tools/pg-rig/rig.mjs';");
    expect(WORKFLOW).toContain(`const NAME = '${M182}';`);
    expect(WORKFLOW).toContain('writeFileSync(PATH, normalized');
    expect(marker).toBeLessThan(start);
  });

  it('the canonical helper pins every measured hash and never touches Production', () => {
    expect(RIG).toContain('M182_SOURCE_SHA256');
    for (const contract of M182_FUNCTIONS) {
      expect(RIG).toContain(contract.rawHash);
      expect(RIG).toContain(contract.productionHash);
    }
    expect(WORKFLOW).toMatch(/disposable runner checkout|ephemeral replay only/i);
    expect(WORKFLOW).toContain('remain untouched');
  });
});

/**
 * The local Supabase CLI provisions public-schema default ACLs that grant the
 * client-facing roles far more than either Production or
 * tools/pg-rig/bootstrap.sql does. RE-MEASURED 2026-08-27 on a pristine stack
 * with ZERO Phoenix migrations (CLI 2.116.0, postgres 17.6.1.165 — the exact
 * images CI resolves today):
 *
 *     postgres | public | table    | anon | arwdDxtm
 *     postgres | public | FUNCTION | {postgres, anon, authenticated, service_role} = EXECUTE
 *
 * Production has neither (`ANON_PUBLIC_RELATION_PRIVILEGES = {}`), and the rig
 * models a FUNCTION default for service_role ONLY.
 *
 * AN EARLIER REVISION OF THIS FILE RECORDED A NARROWER TABLE MEASUREMENT —
 * `anon | MAINTAIN,REFERENCES,TRIGGER,TRUNCATE` — and asserted that naming
 * SELECT/INSERT/UPDATE/DELETE "would be guesswork because the default never
 * granted them". That was true of the older platform and is now FALSE. The
 * measured default is the full `arwdDxtm`, so the four-privilege revoke left
 * `anon` holding INSERT/SELECT/UPDATE/DELETE on every table created before
 * migration 109, and migration 191 fail-closed with "anon holds a direct
 * SELECT on a topology table". Naming all eight is now measurement, not
 * guesswork — and the negative assertion that forbade naming them has been
 * replaced by a positive one pinning the exact measured set.
 *
 * Each un-normalized row takes a fresh replay down at a different migration,
 * every one of them fail-closed, all three reproduced in a disposable replay:
 *
 *   * anon FUNCTION EXECUTE          -> 045 aborts P0004 ("anon must NOT have
 *     EXECUTE on phoenix_update_my_whatsapp_phone"). 045 REVOKEs FROM PUBLIC,
 *     which cannot remove a DIRECT anon grant.
 *   * authenticated FUNCTION EXECUTE -> 109 aborts P0004 ("default-privilege
 *     lockdown incomplete: ... still grants EXECUTE to authenticated").
 *   * anon TABLE SELECT              -> 191 aborts P0001 (above).
 *
 * Migration 109 cannot clear the function rows itself: it revokes function
 * defaults at GLOBAL scope — the only scope Postgres honours when no
 * schema-scoped row exists, per 109's own documented quirk — while this
 * platform provisions a SCHEMA-scoped row. The two scopes never intersect.
 *
 * With both normalizations the disposable replay reached ceiling 200/200 with
 * zero anon relation privilege tuples in `public`, exactly Production's
 * contract. The CONTRACT these assertions defend is "zero final anon relation
 * privileges" and "no client-facing role inherits a function default", not any
 * particular tuple count. They pin each normalization's exact shape so that a
 * future edit cannot silently re-open the source.
 */
describe('E2E workflow · anon platform normalization', () => {
  /** The exact measured anon TABLE default: arwdDxtm, all eight. */
  const TABLE_PRIVILEGES = ['INSERT', 'SELECT', 'UPDATE', 'DELETE', 'MAINTAIN', 'REFERENCES', 'TRIGGER', 'TRUNCATE'];

  const NORMALIZATION =
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE '
    + 'INSERT, SELECT, UPDATE, DELETE, MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLES FROM anon;';

  const FUNCTION_NORMALIZATION =
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE '
    + 'EXECUTE ON FUNCTIONS FROM anon, authenticated;';

  it('revokes the exact proven default privileges, from the exact proven principal', () => {
    expect(WORKFLOW).toContain(NORMALIZATION);
    expect(WORKFLOW).toContain('E2E-ANON-PLATFORM-NORMALIZATION');
  });

  it('revokes the FUNCTION default EXECUTE from both proven-divergent principals', () => {
    // anon is proven by 045, authenticated by 109. service_role is NOT named —
    // its EXECUTE default is a real platform fact the mirror installs below.
    expect(WORKFLOW).toContain(FUNCTION_NORMALIZATION);
  });

  it('is scoped to the proven owner, schema and object type', () => {
    // FOR ROLE postgres — the owner of every Phoenix relation; IN SCHEMA public;
    // ON TABLES. A global or wrong-owner revoke would not remove this entry.
    expect(NORMALIZATION).toMatch(/FOR ROLE postgres/);
    expect(NORMALIZATION).toMatch(/IN SCHEMA public/);
    expect(NORMALIZATION).toMatch(/ON TABLES FROM anon;$/);
    // The function revoke is schema-scoped for the same reason: the platform's
    // row is schema-scoped, and a global revoke would not remove it.
    expect(FUNCTION_NORMALIZATION).toMatch(/FOR ROLE postgres/);
    expect(FUNCTION_NORMALIZATION).toMatch(/IN SCHEMA public/);
    expect(FUNCTION_NORMALIZATION).toMatch(/ON FUNCTIONS FROM anon, authenticated;$/);
  });

  it('names the EXACT measured privilege set — no more, no less', () => {
    // Positive pin. The earlier negative form (forbidding SELECT/INSERT/UPDATE/
    // DELETE) encoded a stale measurement and is deliberately not reinstated.
    for (const priv of TABLE_PRIVILEGES) expect(NORMALIZATION).toContain(priv);
    // Exactly eight privileges, so a future edit cannot quietly add a ninth.
    const named = NORMALIZATION.replace(/^.*REVOKE /, '').replace(/ ON TABLES.*$/, '').split(', ');
    expect(named.sort()).toEqual([...TABLE_PRIVILEGES].sort());
    // The function revoke is EXECUTE only — the sole privilege a function has.
    expect(FUNCTION_NORMALIZATION.replace(/^.*REVOKE /, '').replace(/ ON FUNCTIONS.*$/, '')).toBe('EXECUTE');
  });

  it('does not over-revoke: no blanket REVOKE ALL, and never from PUBLIC', () => {
    // Minimum measured privilege set only, on both object classes.
    expect(EXEC_WORKFLOW).not.toMatch(/REVOKE ALL[^\n;]*ON TABLES FROM anon/i);
    expect(EXEC_WORKFLOW).not.toMatch(/REVOKE ALL[^\n;]*ON FUNCTIONS FROM/i);
    expect(EXEC_WORKFLOW).not.toMatch(/REVOKE[^\n;]*ON TABLES FROM PUBLIC/i);
    expect(EXEC_WORKFLOW).not.toMatch(/REVOKE[^\n;]*ON FUNCTIONS FROM PUBLIC/i);
    // No wildcard/broadening: every revoke stays schema-scoped to public.
    for (const line of EXEC_WORKFLOW.split('\n').filter((l) => /ALTER DEFAULT PRIVILEGES[^\n;]*REVOKE/.test(l))) {
      expect(line).toContain('IN SCHEMA public');
    }
  });

  it('does not disturb the authenticated / service_role platform baseline', () => {
    // The anon TABLE revoke must not be widened to the roles whose baseline the
    // mirror deliberately installs.
    expect(NORMALIZATION).not.toMatch(/authenticated|service_role/);
    // The FUNCTION revoke names authenticated by measurement (109 refuses it),
    // but service_role must NEVER be stripped — 109's own VERIFY asserts it
    // keeps a default EXECUTE, and H-23 depends on it for pre-109 functions.
    expect(FUNCTION_NORMALIZATION).not.toMatch(/service_role/);
    for (const stmt of PLATFORM_BASELINE_STATEMENTS) expect(WORKFLOW).toContain(stmt);
  });

  it('normalizes the PLATFORM, never Phoenix objects after creation', () => {
    // No per-function REVOKE bolted on after the migration created it, and no
    // edit to the immutable migration that would otherwise be the easy way out.
    expect(EXEC_WORKFLOW).not.toMatch(/REVOKE[^\n;]*ON FUNCTION public\.phoenix_/i);
  });

  it('runs BEFORE migration 001 creates any Phoenix table', () => {
    // Default ACLs are prospective only: after 001 it would be far too late.
    const normIdx = WORKFLOW.indexOf('E2E-ANON-PLATFORM-NORMALIZATION');
    const catIdx = WORKFLOW.indexOf('cat supabase/migrations/001_phoenix_core_schema.sql');
    expect(normIdx).toBeGreaterThan(-1);
    expect(catIdx).toBeGreaterThan(normIdx);
    // Both revokes must sit inside that pre-001 window, not after the cat.
    expect(WORKFLOW.indexOf(NORMALIZATION)).toBeGreaterThan(normIdx);
    expect(WORKFLOW.indexOf(NORMALIZATION)).toBeLessThan(catIdx);
    expect(WORKFLOW.indexOf(FUNCTION_NORMALIZATION)).toBeGreaterThan(normIdx);
    expect(WORKFLOW.indexOf(FUNCTION_NORMALIZATION)).toBeLessThan(catIdx);
  });

  it('the post-start proof asserts the anon surface is empty', () => {
    expect(WORKFLOW).toMatch(/anon holds|has_table_privilege\('anon'/);
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
