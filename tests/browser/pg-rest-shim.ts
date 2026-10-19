/**
 * R1 acceptance - a LOCAL, TEST-ONLY PostgREST-style shim in front of the disposable PostgreSQL rig.
 *
 * Purpose: let a real browser drive the real application code (real supabase-js client, real service modules) against the REAL SQL
 * candidates. Every RPC and every RLS-governed read is executed inside a transaction as `SET LOCAL ROLE authenticated` (or `anon`) with
 * `request.jwt.claim.sub` = the account named by the bearer token, exactly the identity model the SQL tests use. It implements only what
 * the journey calls: `/rest/v1/rpc/<fn>` (named arguments), two table reads with `eq` filters / order, `/auth/v1/user`, plus a few
 * `/test/*` endpoints. It is bound to 127.0.0.1, accepts unsigned tokens (a rig convenience), and is never part of the application.
 */
import http from 'node:http';
import type { Pool, PoolClient } from 'pg';

export interface ShimCall { kind: 'rpc' | 'table' | 'test'; name: string; sub: string | null; status: number; code?: string }
export interface Shim {
  url: string;
  calls: ShimCall[];
  /** Delay the NEXT request whose key matches (an RPC name, `table:<name>` or `test:<name>`) by `ms`. One-shot. */
  hold(key: string, ms: number): void;
  close(): Promise<void>;
}

const TABLES = new Set(['central_needs_plans', 'central_needs_plan_revisions', 'central_items']);
const IDENT = /^[a-z][a-z0-9_]*$/;

const subOf = (auth: string | undefined): string | null => {
  const m = /^Bearer (.+)$/.exec(auth ?? '');
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 3) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof p.sub === 'string' ? p.sub : null;
  } catch { return null; }
};

async function asRole<T>(pool: Pool, sub: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${sub ? 'authenticated' : 'anon'}`);
    if (sub) await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  req.on('data', (d: Buffer) => chunks.push(d));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

export async function startShim(pool: Pool): Promise<Shim> {
  const calls: ShimCall[] = [];
  const holds = new Map<string, number[]>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const server = http.createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? '*'),
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'access-control-expose-headers': 'content-range',
    };
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, { ...cors, 'content-type': 'application/json', ...extra });
      res.end(text);
    };
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const sub = subOf(req.headers.authorization);
    const log = (kind: ShimCall['kind'], name: string, status: number, code?: string) => calls.push({ kind, name, sub, status, code });
    const maybeHold = async (key: string) => { const q = holds.get(key); if (q && q.length) await sleep(q.shift()!); };

    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

      if (u.pathname === '/auth/v1/user') {
        if (!sub) return send(401, { message: 'no session' });
        return send(200, { id: sub, aud: 'authenticated', role: 'authenticated', email: `${sub}@rig.invalid`, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() });
      }
      if (u.pathname === '/auth/v1/logout') { res.writeHead(204, cors); res.end(); return; }

      // ---------------- RPC ----------------
      const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(u.pathname);
      if (rpc && req.method === 'POST') {
        const fn = rpc[1];
        await maybeHold(fn);
        const args = (JSON.parse((await readBody(req)) || '{}') ?? {}) as Record<string, unknown>;
        const keys = Object.keys(args);
        if (!keys.every((k) => /^p_[a-z0-9_]+$/.test(k))) { log('rpc', fn, 400); return send(400, { code: 'PGRST100', message: 'bad argument name', details: null, hint: null }); }
        const info = await pool.query(
          `SELECT p.proretset, pg_catalog.format_type(p.prorettype, NULL) AS rt FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1`, [fn]);
        if (!info.rows.length) { log('rpc', fn, 404); return send(404, { code: 'PGRST202', message: `Could not find the function public.${fn}`, details: null, hint: null }); }
        const params = keys.map((k) => { const v = args[k]; return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v; });
        const sql = `SELECT * FROM public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
        try {
          const result = await asRole(pool, sub, (c) => c.query(sql, params));
          log('rpc', fn, 200);
          if (info.rows[0].proretset) return send(200, result.rows);
          if (info.rows[0].rt === 'void') { res.writeHead(204, cors); res.end(); return; }
          const row = result.rows[0] ?? {};
          return send(200, Object.prototype.hasOwnProperty.call(row, fn) ? row[fn] : row);
        } catch (e) {
          const err = e as { code?: string; message?: string; detail?: string; hint?: string };
          const status = err.code === '42501' ? 403 : 400;
          log('rpc', fn, status, err.code);
          return send(status, { code: err.code ?? 'P0001', message: err.message ?? 'error', details: err.detail ?? null, hint: err.hint ?? null });
        }
      }

      // ---------------- table reads (RLS governed) ----------------
      const tbl = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname);
      if (tbl && req.method === 'GET' && TABLES.has(tbl[1])) {
        const table = tbl[1];
        await maybeHold(`table:${table}`);
        const cols = (u.searchParams.get('select') ?? '*').split(',').map((s) => s.trim());
        if (!cols.every((c) => c === '*' || IDENT.test(c))) { log('table', table, 400); return send(400, { code: 'PGRST100', message: 'bad select', details: null, hint: null }); }
        const where: string[] = []; const params: unknown[] = [];
        for (const [k, v] of u.searchParams) {
          if (['select', 'order', 'limit', 'offset', 'or'].includes(k)) continue;
          const m = /^eq\.(.*)$/.exec(v);
          if (!IDENT.test(k) || !m) { log('table', table, 400); return send(400, { code: 'PGRST100', message: 'unsupported filter', details: null, hint: null }); }
          params.push(m[1]); where.push(`${k} = $${params.length}`);
        }
        // PostgREST `or=(col.op.value,...)` with quoted values (ilike / eq / imatch only - what the shared resolver emits)
        const orParam = u.searchParams.get('or');
        if (orParam) {
          const inner = orParam.replace(/^\(/, '').replace(/\)$/, '');
          const terms: string[] = []; let cur = ''; let q = false;
          for (let i = 0; i < inner.length; i++) {
            const ch = inner[i];
            if (ch === '\\' && q) { cur += ch + (inner[++i] ?? ''); continue; }
            if (ch === '"') q = !q;
            if (ch === ',' && !q) { terms.push(cur); cur = ''; continue; }
            cur += ch;
          }
          if (cur) terms.push(cur);
          const parts: string[] = [];
          for (const t of terms) {
            const mm = /^([a-z_]+)\.(ilike|eq|imatch)\.(.*)$/s.exec(t);
            if (!mm || !IDENT.test(mm[1])) { log('table', table, 400); return send(400, { code: 'PGRST100', message: 'unsupported or-term', details: null, hint: null }); }
            let val = mm[3];
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(["\\])/g, '$1');
            params.push(val);
            parts.push(`${mm[1]}${mm[2] === 'ilike' ? ' ILIKE ' : mm[2] === 'eq' ? ' = ' : ' ~* '}$${params.length}`);
          }
          if (parts.length) where.push(`(${parts.join(' OR ')})`);
        }
        const order = u.searchParams.get('order');
        let orderSql = '';
        if (order) {
          const segs = order.split(',').map((x) => /^([a-z_]+)\.(asc|desc)$/.exec(x));
          if (segs.some((x) => !x)) { log('table', table, 400); return send(400, { code: 'PGRST100', message: 'bad order', details: null, hint: null }); }
          orderSql = ' ORDER BY ' + segs.map((x) => `${x![1]} ${x![2].toUpperCase()}`).join(', ');
        }
        const lim = Number(u.searchParams.get('limit') ?? 0);
        const limitSql = Number.isInteger(lim) && lim > 0 && lim <= 1000 ? ` LIMIT ${lim}` : '';
        try {
          const result = await asRole(pool, sub, (c) => c.query(`SELECT ${cols.join(', ')} FROM public.${table}${where.length ? ' WHERE ' + where.join(' AND ') : ''}${orderSql}${limitSql}`, params));
          const single = String(req.headers.accept ?? '').includes('application/vnd.pgrst.object+json');
          if (single) {
            if (result.rows.length !== 1) { log('table', table, 406, 'PGRST116'); return send(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${result.rows.length} rows`, hint: null }); }
            log('table', table, 200); return send(200, result.rows[0]);
          }
          log('table', table, 200);
          return send(200, result.rows);
        } catch (e) {
          const err = e as { code?: string; message?: string; detail?: string; hint?: string };
          log('table', table, 400, err.code);
          return send(400, { code: err.code ?? 'P0001', message: err.message ?? 'error', details: err.detail ?? null, hint: err.hint ?? null });
        }
      }

      // ---------------- test-only endpoints (plain SQL on the rig; not the shared resolver) ----------------
      if (u.pathname === '/test/beneficiaries') {
        await maybeHold('test:beneficiaries');
        const r = await pool.query(`SELECT id, name, name_ar AS "nameAr" FROM organizations WHERE organization_kind = 'care_institution' AND status = 'active' ORDER BY name`);
        log('test', 'beneficiaries', 200); return send(200, r.rows);
      }
      if (u.pathname === '/test/orgs') {
        const r = await pool.query(`SELECT id, name, name_ar, code, status, coalesce(city,'') AS city, contact_email, organization_kind, institution_class FROM organizations WHERE organization_kind = 'care_institution' AND status = 'active' ORDER BY name`);
        log('test', 'orgs', 200); return send(200, r.rows);
      }
      if (u.pathname === '/test/catalog' || u.pathname === '/test/identity') {
        const name = u.pathname.slice(6);
        await maybeHold(`test:${name}`);
        const q = (u.searchParams.get('q') ?? '').trim();
        const r = q.length < 2 ? { rows: [] as Array<Record<string, unknown>> }
          : await pool.query(`SELECT id, name, name_ar, concentration, dosage_form, unit, lower(name) = lower($2) AS exact FROM central_items
                               WHERE status = 'active' AND (name ILIKE $1 OR name_ar ILIKE $1) ORDER BY name LIMIT 20`, [`%${q}%`, q]);
        log('test', name, 200);
        if (name === 'catalog') return send(200, r.rows.map((x) => ({ id: x.id, name: x.name, nameAr: x.name_ar, concentration: x.concentration, dosageForm: x.dosage_form, unit: x.unit })));
        return send(200, r.rows.map((x) => ({ source: 'catalog', centralItemId: x.id, scientificName: x.name, nameAr: x.name_ar, tradeName: null, concentration: x.concentration,
          dosageForm: x.dosage_form, unit: x.unit, nationalCode: null, grade: x.exact ? 'confirmed' : 'strong' })));
      }

      log('test', u.pathname, 404);
      return send(404, { code: 'PGRST404', message: 'not found', details: null, hint: null });
    } catch (e) {
      return send(500, { code: 'XX000', message: String((e as Error).message), details: null, hint: null });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    hold: (key, ms) => { const q = holds.get(key) ?? []; q.push(ms); holds.set(key, q); },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
