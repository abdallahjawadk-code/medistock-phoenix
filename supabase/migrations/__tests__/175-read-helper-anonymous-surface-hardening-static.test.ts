import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = '175_phoenix_read_helper_anonymous_surface_hardening.sql';
const sql = readFileSync(join(__dirname, '..', FILE), 'utf8');
const executable = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

const TARGETS = [
  'public.phoenix_profile_has_permission(uuid,text)',
  'public.phoenix_provenance_reconciliation()',
  'public.phoenix_warehouse_source_balances(uuid)',
] as const;

describe('175 · exact Wave-2 helper ACL scope', () => {
  it('pins exactly three reviewed helpers', () => {
    for (const target of TARGETS) expect(sql).toContain(`'${target}'`);
    expect(TARGETS).toHaveLength(3);
  });

  it('removes only PUBLIC/anon execution and introduces no grants', () => {
    expect(sql).toContain("FROM PUBLIC';");
    expect(sql).toContain("FROM anon';");
    expect(executable).not.toMatch(/^\s*GRANT\s/mi);
    expect(executable).not.toMatch(/REVOKE[^;\n]*(authenticated|service_role)/i);
  });

  it('requires direct authenticated and service_role grants before hardening', () => {
    expect(sql).toContain("r.rolname = 'authenticated'");
    expect(sql).toContain("r.rolname = 'service_role'");
    expect(sql).toContain('authenticated direct grant absent');
    expect(sql).toContain('service_role direct grant absent');
  });

  it('fingerprints definitions and fails closed', () => {
    expect(sql).toContain('pg_get_functiondef');
    expect(sql).toContain('PREFLIGHT FAILED (175)');
    expect(sql).toContain('VERIFY FAILED (175)');
    expect(sql).toContain('function definition changed');
  });

  it('contains no structural/data/RLS/default-privilege change', () => {
    for (const forbidden of [
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i,
      /ALTER\s+FUNCTION/i,
      /DROP\s+FUNCTION/i,
      /ALTER\s+TABLE/i,
      /CREATE\s+TABLE/i,
      /DROP\s+TABLE/i,
      /CREATE\s+POLICY/i,
      /DROP\s+POLICY/i,
      /ALTER\s+POLICY/i,
      /ROW\s+LEVEL\s+SECURITY/i,
      /CREATE\s+TRIGGER/i,
      /DROP\s+TRIGGER/i,
      /ALTER\s+DEFAULT\s+PRIVILEGES/i,
      /^\s*(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)/mi,
    ]) expect(executable).not.toMatch(forbidden);
  });
});

describe('175 · preservation boundaries', () => {
  it('preserves public QR and never revokes it', () => {
    expect(sql).toContain('public.get_public_qr_payload(text)');
    expect(executable).not.toMatch(/REVOKE[^;\n]*get_public_qr_payload/i);
  });

  it('does not harden identity or trigger functions in this wave', () => {
    for (const excluded of [
      'phoenix_my_role',
      'phoenix_my_org',
      'phoenix_guard_dp_archive_update',
      'phoenix_handle_new_user',
      'phoenix_populate_actor_snapshot',
      'phoenix_set_updated_at',
    ]) {
      expect(executable).not.toMatch(new RegExp(`REVOKE[^;\\n]*${excluded}`, 'i'));
    }
  });
});
