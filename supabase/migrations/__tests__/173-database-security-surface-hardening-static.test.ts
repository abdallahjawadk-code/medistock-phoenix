/**
 * 173 · DATABASE SECURITY SURFACE HARDENING — static contract.
 *
 * Migration 173 is deliberately the narrowest thing that can fix finding C1:
 * three REVOKEs against ONE exact function overload. These assertions exist to
 * keep it that way — a future edit that widens it (a blanket revoke, a body
 * change, a second function, an ALTER DEFAULT PRIVILEGES) fails here rather
 * than in Production.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = '173_phoenix_database_security_surface_hardening.sql';
const sql = readFileSync(join(__dirname, '..', FILE), 'utf8');

describe('173 · scope is exactly one function overload', () => {
  it('revokes EXECUTE from PUBLIC, anon and authenticated by exact signature', () => {
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      expect(sql).toContain(
        `REVOKE EXECUTE ON FUNCTION public.get_profile_identity_snapshot(uuid) FROM ${role};`,
      );
    }
  });

  it('revokes nothing else — no other function is named in a REVOKE', () => {
    const revoked = [...sql.matchAll(/REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+([a-z_.]+\([^)]*\))/gi)]
      .map(m => m[1].toLowerCase());
    expect([...new Set(revoked)]).toEqual(['public.get_profile_identity_snapshot(uuid)']);
  });

  it('never uses a blanket revoke', () => {
    expect(sql).not.toMatch(/REVOKE[\s\S]{0,80}ALL\s+FUNCTIONS/i);
    expect(sql).not.toMatch(/REVOKE[\s\S]{0,80}ALL\s+TABLES/i);
    expect(sql).not.toMatch(/REVOKE\s+ALL\s+PRIVILEGES/i);
  });

  it('issues no GRANT at all — this migration only removes reach', () => {
    // Comments may DISCUSS the rollback grant; no executable GRANT may exist.
    const executable = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    expect(executable).not.toMatch(/^\s*GRANT\s/mi);
  });

  it('does not touch the function itself', () => {
    const executable = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    expect(executable).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(executable).not.toMatch(/DROP\s+FUNCTION/i);
    expect(executable).not.toMatch(/ALTER\s+FUNCTION/i);
  });

  it('changes no table, view, policy, trigger or default privilege', () => {
    const executable = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    for (const forbidden of [
      /ALTER\s+TABLE/i, /CREATE\s+TABLE/i, /DROP\s+TABLE/i,
      /CREATE\s+(OR\s+REPLACE\s+)?VIEW/i,
      /CREATE\s+POLICY/i, /DROP\s+POLICY/i, /ALTER\s+POLICY/i,
      /ROW\s+LEVEL\s+SECURITY/i,
      /CREATE\s+TRIGGER/i, /DROP\s+TRIGGER/i,
      /ALTER\s+DEFAULT\s+PRIVILEGES/i,
    ]) {
      expect(executable).not.toMatch(forbidden);
    }
  });

  it('writes no data', () => {
    const executable = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    expect(executable).not.toMatch(/^\s*(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)/mi);
  });
});

describe('173 · fails closed', () => {
  it('preflights the target overload, its SECURITY DEFINER status and its search_path', () => {
    expect(sql).toContain('PREFLIGHT FAILED (173)');
    expect(sql).toMatch(/to_regprocedure\(v_target\)\s+IS\s+NULL/);
    expect(sql).toContain('is no longer SECURITY DEFINER');
    expect(sql).toContain("lost 064''s explicit search_path");
  });

  it('refuses to run if the exposure it exists to remove is already absent', () => {
    expect(sql).toContain('already unreachable by anon and authenticated');
  });

  it('proves the definition is byte-identical before and after', () => {
    expect(sql).toContain('v_def_before := pg_get_functiondef');
    expect(sql).toContain('v_def_after := pg_get_functiondef');
    expect(sql).toContain('VERIFY FAILED (173): the function definition changed');
  });

  it('verifies anon and authenticated lost EXECUTE', () => {
    expect(sql).toContain('anon can still execute');
    expect(sql).toContain('authenticated can still execute');
  });
});

describe('173 · public QR stays anonymous', () => {
  it('preflights AND verifies that anon keeps EXECUTE on the QR payload', () => {
    expect(sql).toContain('public.get_public_qr_payload(text)');
    expect(sql).toContain('the public QR contract is not in its expected state');
    expect(sql).toContain('public QR must remain anonymous');
  });

  it('never revokes anything from the QR function', () => {
    // Executable lines only. The prose above legitimately discusses
    // "un-revoked PUBLIC EXECUTE", and a naive scan of the whole file would
    // match that comment rather than a statement.
    const executable = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    expect(executable).not.toMatch(/REVOKE[^;]*get_public_qr_payload/i);
  });
});

describe('173 · rollback guidance is documented, not executed', () => {
  it('documents restoring only the grant that provably existed', () => {
    expect(sql).toContain('ROLLBACK GUIDANCE');
    expect(sql).toContain('deliberately NOT executed');
    // 013's grant is the only reviewed prior grant; the implicit PUBLIC
    // default is explicitly NOT offered as a rollback step.
    expect(sql).toContain('never an explicit project grant');
  });
});
