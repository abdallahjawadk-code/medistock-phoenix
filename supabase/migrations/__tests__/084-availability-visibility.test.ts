/**
 * AVAILABILITY-CATALOGUE-VISIBILITY-084 — static SQL contract tests.
 *
 * Dynamic proof (real RPC: hide/reactivate, quantity untouched, org scope,
 * permission gate) is in 084-availability-visibility.dynamic.test.ts. These pin
 * the properties that must not regress: the function edits ONLY the 053 removed
 * marker, never quantity/condition; it is additive (drops/revokes nothing
 * existing); it is least-granted; and it reuses the existing availability.update
 * permission key rather than inventing a new RBAC key.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { stripSqlComments, executableSql, sqlFunctionSource } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const NAME = '084_phoenix_availability_visibility.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const active = stripSqlComments(sql);
const exec = executableSql(sql);
const fn = sqlFunctionSource(sql, 'phoenix_set_availability_visibility');
const fnExec = fn ? executableSql(fn) : '';

describe('registration and apply discipline', () => {
  it('is registered', () => expect(REVIEWED_MIGRATION_FILES).toContain(NAME));
  it('is manual-apply only', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });
  it('is a single transaction', () => {
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
  it('aborts fail-closed if the 053 removed marker is absent', () => {
    expect(active).toMatch(/item_availability\.removed_at missing|apply 053 first/);
  });
});

describe('additive — retires nothing here', () => {
  it('drops no table and no function', () => {
    expect(exec).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(exec).not.toMatch(/\bDROP\s+FUNCTION\b/i);
  });
  it('revokes no existing writer (the cutover is a separate migration)', () => {
    expect(exec).not.toMatch(/REVOKE[\s\S]*phoenix_upsert_availability/i);
    expect(exec).not.toMatch(/REVOKE[\s\S]*phoenix_apply_availability_movement/i);
  });
});

describe('the setter edits ONLY the 053 removed marker', () => {
  it('exists', () => expect(fn).not.toBeNull());
  it('sets exactly the removed-marker columns plus last_updated_by', () => {
    // Both branches UPDATE item_availability, touching only
    // removed_at / removed_by / removal_reason / last_updated_by.
    const sets = [...fnExec.matchAll(/UPDATE public\.item_availability\s+SET([\s\S]*?)WHERE id = v_row\.id/g)].map(m => m[1]);
    expect(sets.length).toBe(2); // exactly hide + reactivate
    for (const s of sets) {
      expect(s).toMatch(/removed_at/);
      // never a quantity or condition write
      expect(s).not.toMatch(/\bquantity\s*=/);
      expect(s).not.toMatch(/\bcondition\s*=/);
    }
  });
  it('never writes quantity or condition anywhere in its body', () => {
    expect(fnExec).not.toMatch(/UPDATE public\.item_availability[\s\S]*?\bquantity\s*=/);
    expect(fnExec).not.toMatch(/UPDATE public\.item_availability[\s\S]*?\bcondition\s*=/);
  });
});

describe('security posture', () => {
  it('is SECURITY DEFINER with a pinned search_path', () => {
    expect(fn!).toMatch(/SECURITY DEFINER/);
    expect(fn!).toMatch(/SET search_path = public, pg_temp/);
  });
  it('scopes authority to the org read from the LOCKED row, not a caller value', () => {
    expect(fn!).toMatch(/FOR UPDATE/);
    expect(fn!).toMatch(/v_row\.organization_id IS DISTINCT FROM v_my_org/);
  });
  it('reuses the existing availability.update permission key (no new RBAC key)', () => {
    expect(fnExec).toMatch(/phoenix_profile_has_permission\(v_actor, ''\)/); // literal blanked by executableSql
    expect(fn!).toContain("phoenix_profile_has_permission(v_actor, 'availability.update')");
  });
  it('is least-granted: revoked from PUBLIC/anon, executable only by authenticated', () => {
    expect(active).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_set_availability_visibility\(uuid, boolean, text\) FROM PUBLIC, anon/);
    expect(active).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_set_availability_visibility\(uuid, boolean, text\) TO authenticated/);
  });
});
