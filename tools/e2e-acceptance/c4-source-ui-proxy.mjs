/** Test-only same-origin bridge to the actual C3/C4 handlers; never deployed. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { build } from 'esbuild';

export async function createSourceUiProxy(upstream, registrations, service) {
  assert(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
  assert.equal(upstream.href, 'http://127.0.0.1:4173/');
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP, 'c4-source-ui-'));
  const bridge = join(scratch, 'bridge.mjs'), worker = join(scratch, 'worker.mjs');
  const config = { bundle: true, platform: 'node', target: 'node22', format: 'esm', logLevel: 'silent',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } };
  await build({ ...config, stdin: { contents: `export {authenticate,callerHasCentralNeedsAuthority} from './api/_lib/supabase.ts';
    export {readAuthorizedAnnualC3Original} from './api/_cn2b-core/annual-c3-authorized-source.ts';
    export {runC3IsolatedWorker} from './api/_cn2b-core/annual-c3-worker-boundary.ts';
    export {createC3ReadHandler} from './api/_c3-core/http.ts';
    export {createC4MembershipHandler} from './api/_c4-core/http.ts';
    export {createAnnualSourceDiscoveryHandler} from './api/_c4-core/discovery.ts';`, resolveDir: process.cwd() }, outfile: bridge });
  await build({ ...config, entryPoints: ['api/_c3-core/worker-entry.ts'], outfile: worker });
  const core = await import(pathToFileURL(bridge).href);
  const counters = { discoveries: 0, sourceReads: 0, workers: 0, commits: 0, lostAcknowledgements: 0 };
  const common = { registrations, workerEntry: pathToFileURL(worker), authenticate: core.authenticate,
    authorized: core.callerHasCentralNeedsAuthority, read: core.readAuthorizedAnnualC3Original,
    run: async (...args) => { counters.workers += 1; return core.runC3IsolatedWorker(...args); } };
  const handlers = {
    '/api/central-needs/annual-source-capabilities': core.createAnnualSourceDiscoveryHandler(common),
    '/api/central-needs/extract-original': core.createC3ReadHandler(common),
    '/api/central-needs/commit-verified-membership': core.createC4MembershipHandler({ ...common, service: () => service,
      workerSha256: async () => createHash('sha256').update(readFileSync(worker)).digest('hex') }),
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const handler = handlers[url.pathname];
    if (!handler) {
      if (url.pathname.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
      const forwarded = httpRequest(new URL(req.url, upstream), { method: req.method, headers: { ...req.headers, host: upstream.host } }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      forwarded.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(forwarded); return;
    }
    try {
      if (url.pathname.endsWith('annual-source-capabilities')) counters.discoveries += 1;
      if (url.pathname.endsWith('extract-original')) counters.sourceReads += 1;
      if (url.pathname.endsWith('commit-verified-membership')) counters.commits += 1;
      const response = await handler(new Request(url, { method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value ?? ''])),
        ...(req.method === 'POST' ? { body: Readable.toWeb(req), duplex: 'half' } : {}) }));
      const body = await response.text();
      if (url.pathname.endsWith('commit-verified-membership') && response.status === 200 && counters.lostAcknowledgements === 0) {
        // Commit really succeeded. Replace its acknowledgement with an unknown
        // response; receipt recovery must not issue a second POST.
        counters.lostAcknowledgements += 1;
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'synthetic_acknowledgement_lost' })); return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(body);
    } catch { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: new URL(`http://127.0.0.1:${server.address().port}/`), counters,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
