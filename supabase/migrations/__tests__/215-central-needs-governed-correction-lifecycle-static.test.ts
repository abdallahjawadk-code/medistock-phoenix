/**
 * C2 / M215 — STATIC proof of the governed Central Needs correction lifecycle.
 *
 *   * registration: M215 sits immediately below C4/M216, now the reviewed
 *     ceiling; nothing above M216 exists;
 *   * FUNCTION-ONLY: no table, column, type, index, trigger, policy, permission
 *     key or role grant;
 *   * the exact function set, each SECURITY DEFINER function pinned to
 *     search_path = public, pg_temp, every function revoked from PUBLIC, client
 *     RPCs granted to authenticated only, internal helpers not client-callable;
 *   * the legacy correction bypass is closed and supersession happens ONLY in
 *     the approval switch;
 *   * domain boundary: no stock, movement, allocation or transfer SQL, and
 *     central_needs_plans.status is never used as lifecycle truth;
 *   * T15: migrations 209-214 are byte-identical to their reviewed content.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  REVIEWED_MIGRATION_FILES, getMaximumReviewedMigrationNumber, getNextUnreviewedMigrationNumber, isReviewedMigrationFile,
} from './helpers/reviewed-migrations';

const MIGRATIONS = join(__dirname, '..');
const FILENAME = '215_phoenix_central_needs_governed_correction_lifecycle.sql';
const SQL = readFileSync(join(MIGRATIONS, FILENAME), 'utf8');
// SQL with -- comments removed, so prose never satisfies or violates a code check.
const CODE = SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

/** Every CREATE OR REPLACE FUNCTION body, keyed by function name. */
const FUNCTIONS = new Map<string, string>();
for (const m of CODE.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([\s\S]*?)\$\$;/g)) FUNCTIONS.set(m[1], m[0]);

const CLIENT_RPCS = {
  phoenix_central_needs_open_plan_revision: '(uuid, integer, boolean)',
  phoenix_central_needs_open_correction_revision: '(uuid, integer, uuid, text)',
  phoenix_central_needs_approve_revision: '(uuid)',
  phoenix_central_needs_reject_revision: '(uuid, text)',
  phoenix_central_needs_revision_lifecycle: '(uuid, integer)',
} as const;
const INTERNAL = {
  _phoenix_central_needs_lock_plan_family_v1: '(uuid, integer)',
  _phoenix_central_needs_human_text_v1: '(text)',
} as const;

/** Reviewed content of the historical Central Needs migrations (LF bytes, SHA-256). */
const HISTORICAL_SHA256: Record<string, string> = {
  '209_phoenix_central_needs_registry.sql': 'a06dddf4214b94634d87f400b3d71274b05c153a5db0d9e899ac62b534d777f4',
  '210_phoenix_central_needs_workflow_rpcs.sql': '9592adc90653d0449fd28f90376e731d6150b8914910ef6f5f25766cb1cffe21',
  '211_phoenix_central_needs_batch_and_disposition.sql': 'd5791431847903db6c1cf0eb9864f862c7372511242179296b1b2bfb4b082358',
  '212_phoenix_central_needs_need_lines.sql': 'f124d775acabb27bc7463f084ba085ac933bc476bf1a4b6a4328c024031a2a43',
  '213_phoenix_central_needs_beneficiary_column_mapping.sql': 'd57e572f5cdb66dfc26bdb1c44123fc0124728fdff027f6a72629da5627c991f',
  '214_phoenix_central_needs_review_readiness_volatility.sql': 'a576c8ced86b943f7ced6d1b1dde193954c4609a0027777bb6252b1a5bfbdb07',
};

describe('C2/M215 static — registration and file hygiene', () => {
  it('is registered at 215, immediately below C4/M216 which is now the ceiling', () => {
    const M216 = '216_phoenix_central_needs_region_persistence.sql';
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files).toContain(FILENAME);
    expect(files).toHaveLength(216);
    expect(files.filter((f) => Number(f.slice(0, 3)) > 214)).toEqual([FILENAME, M216]);
    expect(isReviewedMigrationFile(FILENAME)).toBe(true);
    // C4/M216 (Central Needs beneficiary-region persistence) sits directly after
    // 215 and is now the reviewed ceiling; nothing above it exists.
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.indexOf(FILENAME) + 1]).toBe(M216);
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1]).toBe(M216);
    expect(getMaximumReviewedMigrationNumber()).toBe(216);
    expect(getNextUnreviewedMigrationNumber()).toBe(217);
  });

  it('carries no CR bytes, is one transaction, never rolls itself back, has no MANUAL APPLY ONLY banner', () => {
    expect(SQL.includes('\r')).toBe(false);
    expect((SQL.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((SQL.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(CODE).not.toMatch(/\bROLLBACK\b/);
    expect(SQL).not.toMatch(/MANUAL APPLY ONLY/i);
  });

  it('T15: migrations 209-214 are byte-identical to their reviewed content', () => {
    for (const [file, sha] of Object.entries(HISTORICAL_SHA256)) {
      expect(createHash('sha256').update(readFileSync(join(MIGRATIONS, file))).digest('hex'), file).toBe(sha);
    }
  });
});

describe('C2/M215 static — function-only', () => {
  it('creates no table, column, type, index, trigger, policy, view or sequence and alters no table', () => {
    for (const forbidden of [
      /\bCREATE\s+(UNLOGGED\s+)?TABLE\b/i, /\bALTER\s+TABLE\b/i, /\bADD\s+COLUMN\b/i, /\bDROP\s+TABLE\b/i,
      /\bCREATE\s+TYPE\b/i, /\bALTER\s+TYPE\b/i, /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i, /\bCREATE\s+(CONSTRAINT\s+)?TRIGGER\b/i,
      /\bCREATE\s+POLICY\b/i, /\bALTER\s+POLICY\b/i, /\bCREATE\s+(OR\s+REPLACE\s+)?VIEW\b/i, /\bCREATE\s+SEQUENCE\b/i,
      /\bDROP\s+FUNCTION\b/i,
    ]) expect(CODE, String(forbidden)).not.toMatch(forbidden);
  });

  it('adds no permission key and no role grant', () => {
    expect(CODE).not.toMatch(/\bpermission_keys\b/);
    expect(CODE).not.toMatch(/\brole_permission_defaults\b/);
    expect(CODE).not.toMatch(/\bprofile_permission_overrides\b/);
    // Authorization uses only M209's existing keys, through the canonical guard.
    const keys = [...CODE.matchAll(/'(central_needs\.[a-z_]+)'/g)].map((m) => m[1]);
    expect([...new Set(keys)].sort()).toEqual(['central_needs.approve', 'central_needs.edit', 'central_needs.view']);
  });

  it('defines exactly the reviewed function set', () => {
    expect([...FUNCTIONS.keys()].sort()).toEqual([...Object.keys(CLIENT_RPCS), ...Object.keys(INTERNAL)].sort());
  });

  it('every SECURITY DEFINER function pins search_path = public, pg_temp', () => {
    for (const [name, body] of FUNCTIONS) {
      if (/\bSECURITY DEFINER\b/.test(body)) expect(body, name).toContain('SET search_path = public, pg_temp');
    }
    for (const name of [...Object.keys(CLIENT_RPCS), '_phoenix_central_needs_lock_plan_family_v1']) {
      expect(FUNCTIONS.get(name), name).toMatch(/\bSECURITY DEFINER\b/);
    }
  });

  it('client RPCs are revoked from PUBLIC and anon and granted to authenticated only', () => {
    for (const [name, sig] of Object.entries(CLIENT_RPCS)) {
      expect(CODE).toContain(`REVOKE ALL ON FUNCTION public.${name}${sig} FROM PUBLIC, anon;`);
      expect(CODE).toContain(`GRANT EXECUTE ON FUNCTION public.${name}${sig} TO authenticated;`);
    }
    const grants = [...CODE.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.(\w+)/g)].map((m) => m[1]);
    expect(grants.sort()).toEqual(Object.keys(CLIENT_RPCS).sort());
    expect(CODE).not.toMatch(/GRANT[^;]*\b(anon|PUBLIC|service_role)\b[^;]*;/);
  });

  it('internal helpers are not client-callable', () => {
    for (const [name, sig] of Object.entries(INTERNAL)) {
      expect(CODE).toContain(`REVOKE ALL ON FUNCTION public.${name}${sig} FROM PUBLIC, anon, authenticated;`);
    }
  });
});

describe('C2/M215 static — lifecycle contract', () => {
  const open = FUNCTIONS.get('phoenix_central_needs_open_plan_revision')!;
  const correction = FUNCTIONS.get('phoenix_central_needs_open_correction_revision')!;
  const approve = FUNCTIONS.get('phoenix_central_needs_approve_revision')!;
  const reject = FUNCTIONS.get('phoenix_central_needs_reject_revision')!;
  const history = FUNCTIONS.get('phoenix_central_needs_revision_lifecycle')!;

  it('closes the legacy correction bypass before any lock or write', () => {
    expect(open).toContain("IF p_open_next_revision IS DISTINCT FROM false THEN");
    expect(open).toContain("'central_needs_governed_correction_required'");
    const refusal = open.indexOf('central_needs_governed_correction_required');
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(open.indexOf('pg_advisory_xact_lock'));
    expect(refusal).toBeLessThan(open.indexOf('INSERT INTO'));
    expect(open).not.toContain("'superseded'");
  });

  it('supersedes ONLY inside the approval switch', () => {
    for (const [name, body] of FUNCTIONS) {
      if (name === 'phoenix_central_needs_approve_revision') continue;
      expect(body, name).not.toMatch(/SET\s+status\s*=\s*'superseded'/);
    }
    expect(approve).toMatch(/SET\s+status\s*=\s*'superseded'/);
    // Predecessor first, then target, in the same function — one transaction.
    expect(approve.indexOf("SET status = 'superseded'")).toBeLessThan(approve.indexOf("SET status = 'approved'"));
    expect(approve).toContain('_phoenix_central_needs_lock_plan_family_v1');
    expect(approve).toContain("'central_needs_lifecycle_state_ambiguous'");
    expect(reject).not.toContain("'superseded'");
  });

  it('the correction RPC is fenced, reason-mandatory and audited', () => {
    expect(correction).toContain("'central_needs_revision_stale'");
    expect(correction).toContain("'correction_reason_required'");
    expect(correction).toContain("'expected_latest_revision_id_required'");
    expect(correction).toContain("'central_needs_correction_plan_mismatch'");
    expect(correction).toContain('_phoenix_central_needs_human_text_v1(p_reason)');
    expect(correction).toContain("'central_needs.plan_revision.open_correction'");
    expect(correction).toContain('_phoenix_central_needs_lock_plan_family_v1');
    // The fence is checked before the only INSERT into the revisions table.
    expect(correction.indexOf("'central_needs_revision_stale'"))
      .toBeLessThan(correction.indexOf('INSERT INTO public.central_needs_plan_revisions'));
  });

  it('every lifecycle writer authorizes through the canonical guard', () => {
    expect(open).toContain("_phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.edit')");
    expect(correction).toContain("_phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.edit')");
    expect(approve).toContain("_phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.approve')");
    expect(reject).toContain("_phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.approve')");
    expect(history).toContain("_phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.view')");
  });

  it('the history read is narrow, read-only and VOLATILE (the guard takes FOR KEY SHARE)', () => {
    expect(history).toMatch(/\bVOLATILE\b/);
    expect(history).not.toMatch(/\bSTABLE\b/);
    expect(history).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(history).toContain("a.entity_type = 'central_needs_plan_revision'");
    expect(history).toContain('a.organization_id = p_organization_id');
    expect(history).toMatch(/a\.action IN \(/);
  });
});

describe('C2/M215 static — domain boundary', () => {
  it('touches no stock, movement, allocation or transfer object', () => {
    for (const forbidden of [
      /\bwarehouse_stock\b/, /\boutlet_stock\b/, /\bstock_movements?\b/, /\bmovement_lines?\b/, /\bmovement\b/i,
      /\binventory_transfer/, /\bwarehouse_transfer\b/, /\ballocat/i, /\btransfer_request/i, /\bitem_availability\b/,
    ]) expect(CODE, String(forbidden)).not.toMatch(forbidden);
  });

  it('never uses central_needs_plans.status as lifecycle truth and deletes nothing', () => {
    expect(CODE).not.toMatch(/central_needs_plans\s+SET/i);
    expect(CODE).not.toMatch(/\bplan\.status\b|v_plan\.status\b|p\.status\b/);
    expect(CODE).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(CODE).not.toMatch(/\bTRUNCATE\b/i);
  });
});
