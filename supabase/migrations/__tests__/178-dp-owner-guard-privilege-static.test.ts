/**
 * P0 HOTFIX 178 — static contract of the distribution-point owner-guard
 * privilege fix. Guards the SHAPE of the migration so a later edit cannot
 * silently "fix" the 42501 by removing the lock or widening table privileges.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..');
const NAME = '178_phoenix_distribution_point_owner_guard_privilege_fix.sql';
const sql = readFileSync(join(MIGRATIONS, NAME), 'utf8');
/** Executable SQL only — the file's prose explains WHY a broad GRANT was
 *  rejected, and those sentences must not be mistaken for real statements. */
const exec = sql.replace(/--[^\n]*/g, '');

describe('178 · distribution point owner-guard privilege fix (static)', () => {
  it('replaces exactly the Migration-171 outlet guard, and nothing else', () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public._phoenix_distribution_points_owner_kind_guard_v1()',
    );
    // Exactly one function is replaced by this hotfix.
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?(TABLE|VIEW|POLICY|INDEX|TRIGGER)/i);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|POLICY|TRIGGER|FUNCTION|INDEX)\b/i);
    expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
  });

  it('its ONLY ALTER TABLE is the ownership FK — no other table surgery', () => {
    // 178 legitimately gained one schema change (the ownership invariant), so a
    // blanket "no ALTER TABLE" ban no longer expresses the intent. Pin it to
    // exactly one statement of exactly the expected shape instead, so this stays
    // as tight as the ban it replaces.
    const alters = exec.match(/\bALTER\s+TABLE\b[^;]*/gi) ?? [];
    expect(alters).toHaveLength(1);
    expect(alters[0]).toContain('public.distribution_points');
    expect(alters[0]).toContain('ADD CONSTRAINT distribution_points_wh_org_fk');
    // Nothing may be dropped, detached, or have its RLS/ownership altered.
    expect(exec).not.toMatch(/\bALTER\s+TABLE\b[^;]*\b(DROP|DISABLE|NO FORCE|OWNER TO)\b/i);
  });

  it('pins the ownership invariant structurally and VALIDATED', () => {
    // (warehouse_id, organization_id) must resolve against the pre-existing
    // UNIQUE (id, organization_id) on warehouses.
    expect(exec).toMatch(/FOREIGN KEY\s*\(\s*warehouse_id\s*,\s*organization_id\s*\)/i);
    expect(exec).toMatch(/REFERENCES\s+public\.warehouses\s*\(\s*id\s*,\s*organization_id\s*\)/i);
    // ON DELETE CASCADE mirrors the pre-existing single-column warehouse FK, so
    // warehouse deletion behaviour is unchanged by this hotfix.
    expect(exec).toContain('ON DELETE CASCADE');
    // NOT VALID would leave every pre-existing row unchecked — the invariant
    // would be advisory rather than true. Scoped to the ALTER itself: the
    // verify block legitimately contains the words in its failure message.
    const alter = (exec.match(/\bALTER\s+TABLE\b[^;]*/i) ?? [''])[0];
    expect(alter).not.toMatch(/\bNOT\s+VALID\b/i);
    expect(sql).toContain('178 verify failed: ownership FK exists but is NOT VALID');
    expect(sql).toContain('178 verify failed: ownership FK distribution_points_wh_org_fk is missing');
  });

  it('fails closed, and legibly, if the database already holds a mismatch', () => {
    // A bare 23503 from the ALTER would tell an operator nothing. The preflight
    // must count the offending rows and must not silently repair them: rewriting
    // an outlet's organization_id moves it across an RLS boundary.
    expect(sql).toContain('$ownership_preflight$');
    expect(sql).toContain('violate the warehouse/organization ownership invariant');
    expect(exec).not.toMatch(/\bUPDATE\s+public\.distribution_points\b/i);
    expect(exec).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('carries the corrected security context and a pinned search_path', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public, pg_temp');
  });

  it('keeps the FOR SHARE row lock that Migration 171 depends on', () => {
    // The lock is the fix's hardest constraint: removing it would silence the
    // ACL error while reopening 171's warehouse/outlet race.
    expect(sql).toContain('FOR SHARE');
    expect(sql).toContain('pharmacy_department_authority_warehouse_no_outlets');
  });

  it('grants NO table privilege — the fix must not widen any ACL', () => {
    // The rejected alternative was GRANT UPDATE ON warehouses TO authenticated.
    // Asserted against executable SQL: the header prose names that rejected
    // option on purpose and must not trip this guard.
    expect(exec).not.toMatch(/\bGRANT\b/i);
    expect(exec).not.toMatch(/\bTO\s+(anon|authenticated|PUBLIC)\b/i);
    // The only privilege statement present is the defensive REVOKE.
    const revokes = exec.match(/\bREVOKE\b/gi) ?? [];
    expect(revokes).toHaveLength(1);
    expect(exec).toContain(
      'REVOKE ALL ON FUNCTION public._phoenix_distribution_points_owner_kind_guard_v1()',
    );
  });

  it('is transactional with preflight and fail-closed verify', () => {
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
    expect(sql).toContain('$preflight$');
    expect(sql).toContain('$verify$');
    expect(sql).toContain('178 verify failed: outlet guard is not SECURITY DEFINER');
    expect(sql).toContain('178 verify failed: the FOR SHARE row lock was removed');
  });

  it('every verify assertion literal is single-line (CRLF-portable, cf. 162)', () => {
    // Migration 162 failed on hosted Production because an assertion literal
    // spanned a newline and pg_get_functiondef returned CRLF. Keep every
    // literal single-line so a CRLF paste cannot break this migration.
    const verify = sql.slice(sql.indexOf('$verify$'));
    const literals = [...verify.matchAll(/LIKE\s+'([^']*)'/g)].map(m => m[1]);
    expect(literals.length).toBeGreaterThan(0);
    for (const lit of literals) expect(lit).not.toContain('\n');
  });

  it('does not touch Migration 171, 176 or 177 territory', () => {
    expect(sql).not.toContain('get_public_qr_payload');
    expect(sql).not.toContain('phoenix_outlet_availability_read_model');
    expect(sql).not.toContain('material_identity_key');
    // Executable SQL only. The header prose names the stock tables that FK
    // against distribution_points, because that propagation is precisely why a
    // mismatched outlet is severe rather than cosmetic. Naming a table in a
    // comment is not touching it; writing to it would be, and the assertion
    // below still forbids that.
    expect(exec).not.toMatch(/\b(outlet_stock|warehouse_stock|item_availability)\b/);
  });
});
