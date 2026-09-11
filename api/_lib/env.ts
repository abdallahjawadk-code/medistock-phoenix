/**
 * CN-2B trusted server — environment access.
 *
 * SECRET BOUNDARY. The service-role key is read ONLY here and ONLY from a
 * variable whose name deliberately does not start with `VITE_`. Vite inlines
 * `VITE_`-prefixed variables into the browser bundle at build time, so naming
 * matters as much as usage: a key called `VITE_..._SERVICE_ROLE_KEY` would be
 * shipped to every visitor even if no browser module ever imported it.
 * `src/features/central-needs/__tests__/cn2b-service-role-boundary.test.ts`
 * asserts that neither the name nor the value can reach client code.
 *
 * Nothing in this module is importable from `src/` — the API layer is a
 * separate TypeScript project (`tsconfig.api.json`) and the bundler never
 * resolves it.
 */

/** Thrown when the server is not configured. Never carries the value it looked for. */
export class MissingServerConfigError extends Error {
  constructor(public readonly variable: string) {
    super(`server_not_configured: ${variable}`);
    this.name = 'MissingServerConfigError';
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MissingServerConfigError(name);
  }
  return value.trim();
}

/** Public project URL. Same value the browser uses; not a secret. */
export function supabaseUrl(): string {
  return required('PHOENIX_SUPABASE_URL');
}

/** Anon key — used only to build a client that carries the CALLER's JWT. Not a secret. */
export function supabaseAnonKey(): string {
  return required('PHOENIX_SUPABASE_ANON_KEY');
}

/**
 * Service-role key. Trusted-backend identity only: private storage operations
 * and the two trusted RPCs (authoritative replay, batch registration).
 * Never returned to a caller, never logged, never placed in a response.
 */
export function supabaseServiceRoleKey(): string {
  return required('PHOENIX_SUPABASE_SERVICE_ROLE_KEY');
}

/** Private bucket holding staging uploads and permanent source evidence. */
export const SOURCE_BUCKET = 'central-needs-source-files';

/**
 * CN-2B TRANSPORT POLICY — not a parser limit.
 *
 * These bound what this server will move over the network in one request. They
 * are deliberately separate from `DEFAULT_PARSER_LIMITS` in the frozen CN-2A
 * contract, which governs parsing semantics and is not modified by CN-2B. A
 * transport refusal is reported as a transport error and never as a parser
 * diagnostic, so the two vocabularies cannot be confused.
 */
export const TRANSPORT_LIMITS = {
  /** Largest source object the trusted replay will download from private storage. */
  maxSourceBytes: 64 * 1024 * 1024,
  /** Largest provisional preview document the trusted replay will download. */
  maxPreviewBytes: 128 * 1024 * 1024,
  /** Largest JSON request body any CN-2B endpoint will read. */
  maxRequestBodyBytes: 1 * 1024 * 1024,

  /**
   * SIGNED DOWNLOAD TTL — ours to choose. `createSignedUrl(path, expiresIn)`
   * takes the lifetime as an argument, so this value is really enforced.
   */
  signedDownloadTtlSeconds: 300,

  /**
   * SIGNED UPLOAD TTL — NOT ours to choose, and deliberately not pretended to
   * be. `createSignedUploadUrl()` accepts no expiry argument; the token's
   * lifetime is fixed by Supabase Storage at two hours. Reporting 300 seconds
   * for an upload ticket would be a promise the provider does not keep, so the
   * real contract is stated here and returned to the caller verbatim.
   *
   * If a shorter upload window is ever required it has to come from the
   * provider (or from a server-side revocation path), never from a smaller
   * number asserted locally over an unchanged token.
   */
  signedUploadTtlSeconds: 7200,
  signedUploadTtlSource: 'supabase-storage-provider-default',
} as const;

/**
 * STAGING LIFECYCLE — a required operational prerequisite, recorded here
 * because CN-2B cannot create it.
 *
 * `finalize-import` removes the staging pair on success. Two paths do NOT
 * reach that removal: an upload whose finalize is never called (the person
 * closed the tab), and a finalize that aborts on parity or a rejected entry.
 * Those objects are disposable by construction — they are never read again,
 * since a retry mints a fresh upload id — but nothing deletes them today, so
 * without a lifecycle rule the `staging/` prefix grows without bound.
 *
 * REQUIRED of whoever provisions the bucket: an object-expiry / lifecycle rule
 * on the `staging/` prefix (24 hours is ample — a finalize follows its upload
 * within one request). `permanent/` must be EXCLUDED from any such rule: it is
 * immutable evidence and must never expire.
 *
 * This is deliberately not implemented as a delete sweep in application code:
 * a background deleter with credentials over the evidence bucket is a larger
 * risk than the orphans it would collect.
 */
export const STAGING_LIFECYCLE_REQUIREMENT = {
  prefix: 'staging/',
  maxAgeHours: 24,
  mustNotApplyTo: 'permanent/',
  owner: 'bucket provisioning (not created by CN-2B)',
} as const;
