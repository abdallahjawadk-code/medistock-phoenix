import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SQL = readFileSync(
  join(__dirname, '../146_phoenix_secure_user_provisioning.sql'),
  'utf8',
);

describe('migration 146 — secure user provisioning contract', () => {
  it('introduces a distinct service-only replacement RPC', () => {
    expect(SQL).toContain('create or replace function public.phoenix_admin_provision_profile(');
    expect(SQL).toMatch(
      /grant execute on function public\.phoenix_admin_provision_profile\([\s\S]*?\)\s+to service_role;/i,
    );
    expect(SQL).toMatch(
      /revoke all on function public\.phoenix_admin_provision_profile\([\s\S]*?\)\s+from authenticated;/i,
    );
    expect(SQL).toMatch(
      /revoke all on function public\.phoenix_admin_provision_profile\([\s\S]*?\)\s+from anon;/i,
    );
  });

  it('revokes every API execution path to the legacy UPSERT RPC', () => {
    for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
      expect(SQL).toMatch(
        new RegExp(
          String.raw`revoke all on function public\.phoenix_provision_profile\([\s\S]*?\)\s+from ${role};`,
          'i',
        ),
      );
    }
  });

  it('requires an Edge-generated nonce and actor binding in Auth app metadata', () => {
    expect(SQL).toContain("v_auth_app_meta->>'phoenix_provisioning_nonce'");
    expect(SQL).toContain("v_auth_app_meta->>'phoenix_provisioning_actor_id'");
    expect(SQL).toContain("interval '10 minutes'");
  });

  it('accepts only the exact fail-closed auth-trigger placeholder', () => {
    expect(SQL).toContain("v_target_role is distinct from 'outlet_officer'");
    expect(SQL).toContain('v_target_org is not null');
    expect(SQL).toContain("v_target_login is distinct from 'email'");
    expect(SQL).toContain('v_target_username is not null');
    expect(SQL).toContain('v_target_must_change is distinct from false');
    expect(SQL).toContain('for update of p');
  });

  it('is UPDATE-only and has no UPSERT/ON-CONFLICT replacement path', () => {
    const functionBody = SQL.slice(
      SQL.indexOf('create or replace function public.phoenix_admin_provision_profile('),
      SQL.indexOf('comment on function public.phoenix_admin_provision_profile('),
    );
    const executableBody = functionBody.replace(/--.*$/gm, '');
    expect(functionBody).toContain('update public.profiles');
    expect(executableBody).not.toMatch(/\bon conflict\b/i);
    expect(executableBody).not.toMatch(/\binsert into public\.profiles\b/i);
  });

  it('re-derives active actor role, both dangerous permissions and org scope', () => {
    expect(SQL).toContain("v_actor_status = 'active'");
    expect(SQL).toContain("'users.create'");
    expect(SQL).toContain("'users.assign_role'");
    expect(SQL).toContain('p_organization_id is distinct from v_actor_org');
    expect(SQL).toContain("'cannot_create_privileged_role'");
  });

  it('pins search_path and verifies the final grants in-migration', () => {
    expect(SQL).toMatch(/security definer\s+set search_path = public, pg_temp/i);
    expect(SQL).toContain("has_function_privilege(\n    'service_role', v_new_oid, 'EXECUTE'");
    expect(SQL).toContain("has_function_privilege(\n    'authenticated', v_legacy_oid, 'EXECUTE'");
  });

  it('never accepts or logs a password', () => {
    expect(SQL).not.toMatch(/p_(?:temporary_)?password/i);
    expect(SQL).not.toMatch(/jsonb_build_object\([^;]*password/i);
  });
});
