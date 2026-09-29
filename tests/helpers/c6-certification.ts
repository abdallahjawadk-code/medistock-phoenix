/**
 * C6 — shared harness for the REAL-CORPUS certification suites.
 *
 * Two things live here, and nothing else:
 *
 *   1. CORPUS IDENTITY. The certified Annual Needs archive is read from the
 *      path in PHOENIX_C6_CORPUS_ZIP and is accepted ONLY when its SHA-256 and
 *      byte size are exactly the certified values. A configured path whose
 *      bytes differ is a hard failure, never a skip and never a substitute. The
 *      corpus is never copied into, or written under, this repository.
 *
 *   2. A TRANSPORT MIRROR for `@supabase/supabase-js`. The trusted import
 *      endpoints (`api/_cn2b-core/upload-ticket.ts`, `finalize-import.ts`) run
 *      UNCHANGED — their own `authenticate`, `callerIsAuthorized`,
 *      `resolveRevisionAsCaller`, parity check, digest, session, replay and
 *      batch calls. Only `createClient` is replaced, by a client that forwards
 *      each PostgREST call to the disposable pg-rig the way PostgREST would:
 *        * `rpc(name, args)` — one transaction per call, NAMED arguments cast to
 *          the function's own declared types (read from pg_catalog), executed
 *          under the caller's role (`authenticated` for a user token,
 *          `service_role` for the service key) with the caller's JWT subject;
 *        * `from(t).select(cols).eq(col, v).maybeSingle()` — the one table read
 *          the endpoints perform, under the caller's role, so RLS decides;
 *        * `auth.getUser()` — a token is valid only if this harness issued it;
 *        * private Storage — an in-memory bucket with create-only upload,
 *          signed upload tickets and prefix listing.
 *      Any other client surface throws, so the mirror can never silently
 *      diverge from what the endpoints really call.
 *
 * Gated suites import this module; it touches no database and no file until a
 * suite calls it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// ---------------------------------------------------------------------------
// 1. Corpus identity
// ---------------------------------------------------------------------------

export const C6_CORPUS = {
  env: 'PHOENIX_C6_CORPUS_ZIP',
  sha256: 'b00208ca019c8735790c5401dee26d986234a12279d04e0a057f278bd99eaca2',
  byteSize: 942720,
  /** The certified archive's own name, used as the container filename. */
  archiveName: 'احتياج 2026.zip',
} as const;

export const corpusConfigured = (): boolean => Boolean(process.env[C6_CORPUS.env]);

/**
 * The certified archive bytes. Throws — never skips, never substitutes — when
 * the configured path is not absolute, is not a file, or holds different bytes.
 */
export function loadCertifiedCorpus(): Uint8Array {
  const path = process.env[C6_CORPUS.env];
  if (!path) throw new Error(`${C6_CORPUS.env} is not set`);
  if (!isAbsolute(path)) throw new Error(`${C6_CORPUS.env} must be an absolute path`);
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`${C6_CORPUS.env} is not a file`);
  const bytes = new Uint8Array(readFileSync(path));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== C6_CORPUS.byteSize || sha256 !== C6_CORPUS.sha256) {
    throw new Error(`C6 corpus identity mismatch: sha256=${sha256} bytes=${bytes.byteLength} `
      + `(certified sha256=${C6_CORPUS.sha256} bytes=${C6_CORPUS.byteSize}) — refusing to substitute`);
  }
  return bytes;
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/**
 * What the browser Worker hands the page: the result crosses `postMessage`
 * (structured clone), and the page uploads `JSON.stringify(result)`
 * (useCentralNeedsPreview.ts). Both hops are reproduced.
 */
export const workerPreviewJson = (result: unknown): string => JSON.stringify(structuredClone(result));

// ---------------------------------------------------------------------------
// 2. The @supabase/supabase-js transport mirror
// ---------------------------------------------------------------------------

/** The subset of tools/pg-rig/rig.mjs this mirror uses. */
export interface C6Rig {
  asUser<T>(userId: string | null, fn: (c: any) => Promise<T>, opts?: { role?: string; commit?: boolean }): Promise<T>;
  asAdmin<T>(fn: (c: any) => Promise<T>): Promise<T>;
}

export const C6_SUPABASE_ENV = {
  PHOENIX_SUPABASE_URL: 'https://c6-rig.invalid',
  PHOENIX_SUPABASE_ANON_KEY: 'c6-rig-anon-key',
  PHOENIX_SUPABASE_SERVICE_ROLE_KEY: 'c6-rig-service-role-key',
} as const;

interface ProcSignature { args: Array<{ name: string; type: string }>; defaults: number }
interface PostgrestError { message: string; code: string; details: string | null; hint: string | null }

const mirror = {
  rig: null as C6Rig | null,
  tokens: new Map<string, string>(),
  objects: new Map<string, Uint8Array>(),
  signedUploads: new Map<string, string>(),
  procs: new Map<string, ProcSignature[]>(),
  rpcLog: [] as Array<{ name: string; role: string; userId: string | null; ok: boolean }>,
};

/** Points the mirror at a rig and sets the (non-secret) endpoint configuration. */
export function installC6Supabase(rig: C6Rig): void {
  mirror.rig = rig;
  mirror.tokens.clear();
  mirror.objects.clear();
  mirror.signedUploads.clear();
  mirror.procs.clear();
  mirror.rpcLog.length = 0;
  Object.assign(process.env, C6_SUPABASE_ENV);
}

export function uninstallC6Supabase(): void {
  mirror.rig = null;
  for (const k of Object.keys(C6_SUPABASE_ENV)) delete process.env[k];
}

/** A bearer token for `userId`, as Supabase Auth would issue after sign-in. */
export function tokenFor(userId: string): string {
  const token = `c6.${userId}.${randomUUID()}`;
  mirror.tokens.set(token, userId);
  return token;
}

export const storedObjectKeys = (): string[] => [...mirror.objects.keys()].sort();
export const storedObject = (key: string): Uint8Array | undefined => mirror.objects.get(key);
export const rpcLog = () => mirror.rpcLog;

function rig(): C6Rig {
  if (!mirror.rig) throw new Error('C6 Supabase mirror used before installC6Supabase(rig)');
  return mirror.rig;
}

function toPostgrestError(e: any): PostgrestError {
  return { message: String(e?.message ?? e), code: String(e?.code ?? ''), details: e?.detail ?? null, hint: e?.hint ?? null };
}

async function signaturesOf(name: string): Promise<ProcSignature[]> {
  const cached = mirror.procs.get(name);
  if (cached) return cached;
  const rows: Array<{ args: string; defaults: number }> = await rig().asAdmin((c: any) => c.query(
    `SELECT pg_get_function_identity_arguments(p.oid) AS args, p.pronargdefaults::int AS defaults
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`, [name]).then((r: any) => r.rows));
  const sigs = rows.map((r) => ({
    defaults: r.defaults,
    args: r.args === '' ? [] : r.args.split(', ').map((a) => {
      const i = a.indexOf(' ');
      return { name: a.slice(0, i), type: a.slice(i + 1) };
    }),
  }));
  mirror.procs.set(name, sigs);
  return sigs;
}

/** PostgREST overload resolution by argument NAMES, then a typed named-argument call. */
async function callRpc(role: 'authenticated' | 'service_role', userId: string | null, name: string, args: Record<string, unknown>) {
  const keys = Object.keys(args).filter((k) => args[k] !== undefined);
  const sigs = await signaturesOf(name);
  const sig = sigs.find((s) => {
    const names = s.args.map((a) => a.name);
    const required = names.slice(0, names.length - s.defaults);
    return keys.every((k) => names.includes(k)) && required.every((n) => keys.includes(n));
  });
  if (!sig) {
    mirror.rpcLog.push({ name, role, userId, ok: false });
    return { data: null, error: { message: `Could not find the function public.${name}(${keys.join(', ')})`, code: 'PGRST202', details: null, hint: null } };
  }
  const typeOf = new Map(sig.args.map((a) => [a.name, a.type]));
  const params = keys.map((k) => {
    const v = args[k];
    const t = typeOf.get(k)!;
    return (t === 'jsonb' || t === 'json') && v !== null ? JSON.stringify(v) : v;
  });
  const sql = `SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${typeOf.get(k)}`).join(', ')}) AS result`;
  try {
    const data = await rig().asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0].result), { role, commit: true });
    mirror.rpcLog.push({ name, role, userId, ok: true });
    return { data, error: null };
  } catch (e) {
    mirror.rpcLog.push({ name, role, userId, ok: false });
    return { data: null, error: toPostgrestError(e) };
  }
}

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;
const SAFE_COLUMNS = /^[a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*$/;

function tableRead(role: 'authenticated', userId: string, table: string) {
  if (!SAFE_IDENT.test(table)) throw new Error(`C6 mirror: unsafe table ${table}`);
  let columns = '*';
  const filters: Array<[string, unknown]> = [];
  const builder = {
    select(cols: string) {
      if (!SAFE_COLUMNS.test(cols.trim())) throw new Error(`C6 mirror: unsupported select list ${cols}`);
      columns = cols.trim();
      return builder;
    },
    eq(col: string, value: unknown) {
      if (!SAFE_IDENT.test(col)) throw new Error(`C6 mirror: unsafe column ${col}`);
      filters.push([col, value]);
      return builder;
    },
    async maybeSingle() {
      const where = filters.map(([c], i) => `${c} = $${i + 1}`).join(' AND ') || 'true';
      try {
        const rows = await rig().asUser(userId, (c: any) => c.query(
          `SELECT ${columns} FROM public.${table} WHERE ${where}`, filters.map(([, v]) => v)).then((r: any) => r.rows), { role });
        if (rows.length > 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116', details: null, hint: null } };
        return { data: rows[0] ?? null, error: null };
      } catch (e) {
        return { data: null, error: toPostgrestError(e) };
      }
    },
  };
  return builder;
}

function bucket(name: string) {
  if (name !== 'central-needs-source-files') throw new Error(`C6 mirror: unexpected bucket ${name}`);
  return {
    async list(prefix: string, opts?: { search?: string; limit?: number }) {
      const folder = prefix.endsWith('/') ? prefix : `${prefix}/`;
      const data = [...mirror.objects.entries()]
        .filter(([k]) => k.startsWith(folder) && !k.slice(folder.length).includes('/'))
        .map(([k, v]) => ({ name: k.slice(folder.length), metadata: { size: v.byteLength } }))
        .filter((o) => !opts?.search || o.name.includes(opts.search))
        .slice(0, opts?.limit ?? 100);
      return { data, error: null };
    },
    async download(key: string) {
      const bytes = mirror.objects.get(key);
      return bytes ? { data: new Blob([bytes.slice() as unknown as BlobPart]), error: null } : { data: null, error: { message: 'Object not found' } };
    },
    async upload(key: string, bytes: Uint8Array, opts?: { upsert?: boolean }) {
      if (opts?.upsert !== false) throw new Error('C6 mirror: permanent evidence must be written create-only');
      if (mirror.objects.has(key)) return { data: null, error: { message: 'The resource already exists' } };
      mirror.objects.set(key, new Uint8Array(bytes));
      return { data: { path: key }, error: null };
    },
    async remove(keys: string[]) {
      for (const k of keys) mirror.objects.delete(k);
      return { data: keys.map((name) => ({ name })), error: null };
    },
    async createSignedUploadUrl(key: string) {
      const token = randomUUID();
      mirror.signedUploads.set(key, token);
      return { data: { path: key, token, signedUrl: `https://c6-rig.invalid/upload/${key}?token=${token}` }, error: null };
    },
  };
}

/**
 * The browser's `uploadToSignedUrl`: honoured only for a path and token this
 * mirror signed, once. Staging is the one write the browser performs itself.
 */
export function uploadToSignedUrl(path: string, token: string, bytes: Uint8Array): void {
  if (mirror.signedUploads.get(path) !== token) throw new Error(`C6 mirror: no signed upload for ${path}`);
  mirror.signedUploads.delete(path);
  mirror.objects.set(path, new Uint8Array(bytes));
}

function fakeCreateClient(_url: string, key: string, options?: { global?: { headers?: Record<string, string> } }) {
  const unsupported = (what: string) => () => { throw new Error(`C6 mirror: ${what} is not part of the audited endpoint surface`); };
  if (key === C6_SUPABASE_ENV.PHOENIX_SUPABASE_SERVICE_ROLE_KEY) {
    return {
      rpc: (name: string, args: Record<string, unknown> = {}) => callRpc('service_role', null, name, args),
      from: unsupported('service-role table access'),
      storage: { from: bucket },
      auth: { getUser: unsupported('service-role getUser') },
    };
  }
  if (key !== C6_SUPABASE_ENV.PHOENIX_SUPABASE_ANON_KEY) throw new Error('C6 mirror: unknown API key');
  const header = options?.global?.headers?.Authorization ?? '';
  const token = header.replace(/^Bearer\s+/i, '');
  const userId = mirror.tokens.get(token) ?? null;
  return {
    auth: {
      getUser: async () => (userId
        ? { data: { user: { id: userId } }, error: null }
        : { data: { user: null }, error: { message: 'invalid JWT', status: 401 } }),
    },
    rpc: (name: string, args: Record<string, unknown> = {}) => (userId
      ? callRpc('authenticated', userId, name, args)
      : Promise.resolve({ data: null, error: { message: 'JWT invalid', code: 'PGRST301', details: null, hint: null } })),
    from: (table: string) => {
      if (!userId) throw new Error('C6 mirror: table read without a valid user token');
      return tableRead('authenticated', userId, table);
    },
    storage: { from: unsupported('user-scoped storage') },
  };
}

/** The module `vi.mock('@supabase/supabase-js', ...)` resolves to. */
export const supabaseJsMirror = () => ({ createClient: fakeCreateClient });

// ---------------------------------------------------------------------------
// 3. Driving the two trusted endpoints exactly as the browser does
// ---------------------------------------------------------------------------

export type EndpointHandler = (req: Request) => Promise<Response>;

export async function postJson(handler: EndpointHandler, token: string | null, path: string, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handler(new Request(`https://c6-rig.invalid${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() as any };
}

/**
 * The canonical browser import: upload ticket → signed staging upload of the
 * source bytes and the Worker preview → finalize. Returns every response.
 */
export async function importThroughEndpoints(opts: {
  uploadTicket: EndpointHandler;
  finalizeImport: EndpointHandler;
  token: string;
  planRevisionId: string;
  containerKind: 'file' | 'zip';
  source: Uint8Array;
  previewJson: string;
}) {
  const ticket = await postJson(opts.uploadTicket, opts.token, '/api/central-needs/upload-ticket',
    { planRevisionId: opts.planRevisionId, byteSize: opts.source.byteLength });
  if (ticket.status !== 200) return { ticket, finalize: null };
  uploadToSignedUrl(ticket.body.source.path, ticket.body.source.token, opts.source);
  uploadToSignedUrl(ticket.body.preview.path, ticket.body.preview.token, new TextEncoder().encode(opts.previewJson));
  const finalize = await postJson(opts.finalizeImport, opts.token, '/api/central-needs/finalize-import',
    { planRevisionId: opts.planRevisionId, uploadId: ticket.body.uploadId, containerKind: opts.containerKind });
  return { ticket, finalize };
}

// ---------------------------------------------------------------------------
// 4. Small shared assertions helpers
// ---------------------------------------------------------------------------

export interface Refusal { code: string; message: string; detail?: string; constraint?: string }

/** The database's refusal of `p`, or a thrown error if it unexpectedly succeeded. */
export async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string; constraint?: string };
    const out: Refusal = { code: String(err.code), message: String(err.message) };
    if (err.detail !== undefined) out.detail = err.detail;
    if (err.constraint !== undefined) out.constraint = err.constraint;
    return out;
  }
  throw new Error('expected the database to refuse this call, but it succeeded');
}
