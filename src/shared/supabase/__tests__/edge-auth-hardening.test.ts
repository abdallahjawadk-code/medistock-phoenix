import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EdgeConfigurationError,
  parseBearerAuthorization,
  resolveEdgeApiKeys,
  type EdgeEnvironmentReader,
} from '../../../../supabase/functions/_shared/edge-auth.ts';

const ROOT = resolve(process.cwd());
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

const canonicalPaths = [
  'supabase/functions/admin-create-user/index.ts',
  'supabase/functions/admin-user-lifecycle/index.ts',
  'supabase/functions/admin-recycle-user/index.ts',
];

function reader(values: Record<string, string | undefined>): EdgeEnvironmentReader {
  return (name) => values[name];
}

const validEnvironment = {
  SUPABASE_SECRET_KEYS: JSON.stringify({
    secondary: 'sb_secret_secondary_placeholder',
    default: 'sb_secret_default_placeholder',
  }),
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({
    secondary: 'sb_publishable_secondary_placeholder',
    default: 'sb_publishable_default_placeholder',
  }),
};

describe('canonical Edge API-key resolution', () => {
  it('selects only the key named default from each modern key set', () => {
    expect(resolveEdgeApiKeys(reader(validEnvironment))).toEqual({
      secretKey: 'sb_secret_default_placeholder',
      publishableKey: 'sb_publishable_default_placeholder',
    });
  });

  it.each([
    [{ ...validEnvironment, SUPABASE_SECRET_KEYS: undefined }, 'missing_env'],
    [{ ...validEnvironment, SUPABASE_SECRET_KEYS: '{' }, 'invalid_json'],
    [{ ...validEnvironment, SUPABASE_SECRET_KEYS: '{}' }, 'missing_default'],
    [
      {
        ...validEnvironment,
        SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'legacy-placeholder' }),
      },
      'invalid_key_type',
    ],
    [{ ...validEnvironment, SUPABASE_PUBLISHABLE_KEYS: undefined }, 'missing_env'],
    [
      {
        ...validEnvironment,
        SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({
          default: 'sb_secret_wrong-class-placeholder',
        }),
      },
      'invalid_key_type',
    ],
  ])('fails closed for an invalid key-set environment', (values, issue) => {
    try {
      resolveEdgeApiKeys(reader(values));
      throw new Error('expected resolver to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EdgeConfigurationError);
      expect((error as EdgeConfigurationError).issue).toBe(issue);
      expect((error as Error).message).toBe('EDGE_API_KEY_CONFIGURATION_INVALID');
    }
  });

  it('never reads the legacy service-role environment variable', () => {
    const names: string[] = [];
    resolveEdgeApiKeys((name) => {
      names.push(name);
      return validEnvironment[name as keyof typeof validEnvironment];
    });
    expect(names).toEqual([
      'SUPABASE_SECRET_KEYS',
      'SUPABASE_PUBLISHABLE_KEYS',
    ]);
    expect(names).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('does not log key JSON, key values, or fingerprints on failure', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() =>
      resolveEdgeApiKeys(
        reader({
          ...validEnvironment,
          SUPABASE_SECRET_KEYS: JSON.stringify({
            default: 'invalid-private-placeholder',
          }),
        }),
      ),
    ).toThrow('EDGE_API_KEY_CONFIGURATION_INVALID');

    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('explicit caller authentication', () => {
  it.each([
    null,
    '',
    'Bearer',
    'Bearer ',
    'Basic token',
    'Bearer token extra',
    ' Bearer token',
    'Bearer token ',
  ])('rejects a missing or malformed Authorization header', (value) => {
    expect(parseBearerAuthorization(value)).toBeNull();
  });

  it('accepts one non-empty Bearer token and normalizes the scheme', () => {
    expect(parseBearerAuthorization('bearer user.jwt.token')).toBe(
      'Bearer user.jwt.token',
    );
  });

  it('keeps caller and privileged clients separate in every canonical function', () => {
    for (const path of canonicalPaths) {
      const source = read(path);
      expect(source).toContain('parseBearerAuthorization');
      expect(source).toContain('resolveEdgeApiKeys');
      expect(source).toContain('apiKeys.publishableKey');
      expect(source).toContain('apiKeys.secretKey');
      expect(source).toContain('caller.auth.getUser()');
      expect(source).not.toContain("Deno.env.get('SUPABASE_ANON_KEY')");
      expect(source).not.toContain(
        "Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')",
      );
    }
  });
});

describe('canonical server-authority preservation', () => {
  it('delegates database mutations to existing RPC contracts', () => {
    expect(read(canonicalPaths[0])).toContain('phoenix_admin_provision_profile');

    const lifecycle = read(canonicalPaths[1]);
    for (const rpc of [
      'phoenix_lifecycle_reserve',
      'phoenix_lifecycle_commit',
      'phoenix_lifecycle_compensate',
      'phoenix_lifecycle_enable',
      'phoenix_lifecycle_authorize_rotation',
      'phoenix_lifecycle_note_delete',
    ]) {
      expect(lifecycle).toContain(rpc);
    }

    expect(read(canonicalPaths[2])).toContain('phoenix_recycle_apply');
  });

  it('does not reintroduce direct profile, role, audit, stock, or transfer writes', () => {
    const directWrite =
      /\.from\(['"](profiles|user_roles|audit_logs|warehouse_stock|outlet_stock|warehouse_transfers|warehouse_dispatches|outlet_return_requests)['"]\)[\s\S]{0,120}\.(insert|upsert|update|delete)\s*\(/;

    for (const path of canonicalPaths) {
      expect(read(path)).not.toMatch(directWrite);
    }
  });

  it('preserves suspended-actor, permission, cross-org, IDOR, and role gates in the authoritative contracts', () => {
    const provision = read(
      'supabase/migrations/146_phoenix_secure_user_provisioning.sql',
    );
    const lifecycle = read(
      'supabase/migrations/093_phoenix_super_admin_lifecycle_guard.sql',
    );

    expect(provision).toContain("v_actor_status = 'active'");
    expect(provision).toContain("'users.create'");
    expect(provision).toContain("'cross_org'");
    expect(provision).toContain("'INVALID_ROLE'");

    expect(lifecycle).toContain("v_astatus = 'active'");
    expect(lifecycle).toContain("'users.recycle'");
    expect(lifecycle).toContain("'cross_org'");
    expect(lifecycle).toContain("'self_action'");
    expect(lifecycle).toContain("'target_not_found'");
    expect(lifecycle).toContain("'REQUEST_DENIED'");
  });

  it('preserves replay and compensation contracts where supported', () => {
    const create = read(canonicalPaths[0]);
    const lifecycle = read(canonicalPaths[1]);
    expect(create).toContain('provisioningNonce');
    expect(create).toContain('correlationId');
    expect(lifecycle).toContain('phoenix_lifecycle_reserve');
    expect(lifecycle).toContain('phoenix_lifecycle_compensate');
    expect(lifecycle).toContain('phoenix_lifecycle_commit');
  });
});

describe('future verify_jwt=false transition remains inactive', () => {
  it('keeps the active config and deploy workflows on verify_jwt=true behavior', () => {
    const activeConfig = read('supabase/config.toml');
    expect(activeConfig).not.toMatch(
      /\[functions\.(admin-create-user|admin-user-lifecycle|admin-recycle-user)\][\s\S]{0,80}verify_jwt\s*=\s*false/,
    );

    for (const workflow of [
      '.github/workflows/deploy-admin-create-user.yml',
      '.github/workflows/deploy-admin-user-lifecycle.yml',
    ]) {
      expect(read(workflow)).not.toContain('--no-verify-jwt');
    }
  });

  it('records a non-active future configuration for all three canonical functions', () => {
    const future = read('supabase/config.verify-jwt-future.toml');
    for (const name of [
      'admin-create-user',
      'admin-user-lifecycle',
      'admin-recycle-user',
    ]) {
      expect(future).toContain(`[functions.${name}]`);
    }
    expect(future.match(/verify_jwt\s*=\s*false/g)).toHaveLength(3);
    expect(future).toContain('NOT ACTIVE');
  });
});
