// Shared, fail-closed Edge Function authentication configuration.
//
// Supabase injects the modern key sets as JSON objects keyed by key name.
// Canonical administrative functions use only the key named "default".
// No legacy service-role fallback is permitted.

// @ts-nocheck -- Deno edge runtime types are not part of the app tsconfig.

export type EdgeEnvironmentReader = (name: string) => string | undefined;

export type EdgeConfigurationIssue =
  | 'missing_env'
  | 'invalid_json'
  | 'missing_default'
  | 'invalid_key_type';

export class EdgeConfigurationError extends Error {
  readonly issue: EdgeConfigurationIssue;

  constructor(issue: EdgeConfigurationIssue) {
    super('EDGE_API_KEY_CONFIGURATION_INVALID');
    this.name = 'EdgeConfigurationError';
    this.issue = issue;
  }
}

function readDefaultKey(
  raw: string | undefined,
  requiredPrefix: 'sb_secret_' | 'sb_publishable_',
): string {
  if (!raw) throw new EdgeConfigurationError('missing_env');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EdgeConfigurationError('invalid_json');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EdgeConfigurationError('invalid_json');
  }

  const value = (parsed as Record<string, unknown>).default;
  if (typeof value !== 'string' || value.length === 0) {
    throw new EdgeConfigurationError('missing_default');
  }
  if (value !== value.trim() || !value.startsWith(requiredPrefix)) {
    throw new EdgeConfigurationError('invalid_key_type');
  }

  return value;
}

export function resolveEdgeApiKeys(
  readEnv: EdgeEnvironmentReader = (name) => Deno.env.get(name),
): { secretKey: string; publishableKey: string } {
  return {
    secretKey: readDefaultKey(readEnv('SUPABASE_SECRET_KEYS'), 'sb_secret_'),
    publishableKey: readDefaultKey(
      readEnv('SUPABASE_PUBLISHABLE_KEYS'),
      'sb_publishable_',
    ),
  };
}

export function parseBearerAuthorization(value: string | null): string | null {
  if (!value) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(value);
  return match ? `Bearer ${match[1]}` : null;
}
