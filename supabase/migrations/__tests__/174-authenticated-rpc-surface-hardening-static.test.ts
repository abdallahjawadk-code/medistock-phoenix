import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = '174_phoenix_authenticated_rpc_surface_hardening.sql';
const sql = readFileSync(join(__dirname, '..', FILE), 'utf8');
const executable = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

const TARGETS = [
  'public.archive_entity(text,uuid,text)',
  'public.assign_profile_permissions(uuid,jsonb)',
  'public.assign_profile_role(uuid,text)',
  'public.get_effective_permissions(uuid)',
  'public.get_entity_purge_impact(text,uuid)',
  'public.get_scoped_inter_institution_alerts()',
  'public.phoenix_mark_password_changed()',
  'public.purge_entity_with_all_data(text,uuid,text)',
  'public.reset_profile_permissions(uuid)',
] as const;

describe('174 · exact Wave-1 ACL scope', () => {
  it('pins exactly nine reviewed authenticated APIs', () => {
    for (const target of TARGETS) expect(sql).toContain(`'${target}'`);
    expect(TARGETS).toHaveLength(9);
  });

  it('removes only PUBLIC and anon reach, never authenticated/service_role', () => {
    expect(sql).toContain("FROM PUBLIC';");
    expect(sql).toContain("FROM anon';");
    expect(executable).not.toMatch(/REVOKE[^;\n]*(authenticated|service_role)/i);
    expect(executable).not.toMatch(/^\s*GRANT\s/mi);
  });

  it('does not alter function bodies or structural/database objects', () => {
    for (const forbidden of [
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i,
      /DROP\s+FUNCTION/i,
      /ALTER\s+FUNCTION/i,
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

  it('fails closed and fingerprints every function definition', () => {
    expect(sql).toContain('PREFLIGHT FAILED (174)');
    expect(sql).toContain('VERIFY FAILED (174)');
    expect(sql).toContain('pg_get_functiondef');
    expect(sql).toContain('function definition changed');
  });

  it('requires authenticated and service_role before and after hardening', () => {
    expect(sql).toContain("has_function_privilege('authenticated'");
    expect(sql).toContain("has_function_privilege('service_role'");
    expect(sql).toContain('authenticated lost EXECUTE');
    expect(sql).toContain('service_role lost EXECUTE');
  });
});

describe('174 · deliberate exclusions / preservation', () => {
  it('preserves public QR and never revokes it', () => {
    expect(sql).toContain('public.get_public_qr_payload(text)');
    expect(sql).toContain('anon lost public QR EXECUTE');
    expect(executable).not.toMatch(/REVOKE[^;\n]*get_public_qr_payload/i);
  });

  it('does not harden load-bearing helpers in this wave', () => {
    for (const helper of [
      'phoenix_profile_has_permission',
      'phoenix_my_role',
      'phoenix_my_org',
      'phoenix_warehouse_source_balances',
      'phoenix_provenance_reconciliation',
      'phoenix_set_updated_at',
    ]) {
      const revokePattern = new RegExp(`REVOKE[^;\\n]*${helper}`, 'i');
      expect(executable).not.toMatch(revokePattern);
    }
  });

  it('documents a narrow rollback posture without restoring PUBLIC automatically', () => {
    expect(sql).toContain('ROLLBACK GUIDANCE');
    expect(sql).toContain('do NOT broadly restore');
  });
});
