/**
 * Negative tests of the full-app network lock with LOCAL FAKE servers (no real account, no real environment, nothing leaves 127.0.0.1).
 * A hostile "application" page tries - during the INITIAL LOAD and later - to write: RPC writers, unknown RPCs, table PATCH/DELETE, auth
 * signup/recover/logout, a second backend, beacons, XHR, forms, a WebSocket and a Service Worker. The fake servers record what really
 * arrives. Expectation: ZERO forbidden requests reach any server, while the permitted reads/sign-in still do.
 * R1_GUARD_ENFORCE=0 reproduces the former record-only behaviour (used once to capture the RED run).
 */
import http from 'node:http';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { newLockedContext } from './fullapp-lock';

const chrome = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
  .filter((c): c is string => Boolean(c)).find(existsSync) ?? null;
const run = chrome ? describe : describe.skip;
const ENFORCE = process.env.R1_GUARD_ENFORCE !== '0';

interface Fake { port: number; seen: string[]; close(): Promise<void> }
function fake(handler?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean): Promise<Fake> {
  const seen: string[] = [];
  const s = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    seen.push(`${req.method} ${req.url}`);
    if (handler && handler(req, res)) return;
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }); res.end('[]');
  });
  s.on('upgrade', (req, sock) => { seen.push(`UPGRADE ${req.url}`); sock.destroy(); });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as { port: number }).port, seen, close: () => new Promise<void>((x) => s.close(() => x())) })));
}

let browser: Browser; let backend: Fake; let other: Fake; let app: Fake;
beforeAll(async () => {
  backend = await fake(); other = await fake();
  const B = () => `http://127.0.0.1:${backend.port}`, O = () => `http://127.0.0.1:${other.port}`;
  app = await fake((req, res) => {
    if (req.url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`self.addEventListener('install', () => { fetch('${B()}/rest/v1/rpc/phoenix_central_needs_open_manual_plan_revision', { method: 'POST', mode: 'no-cors', body: 'sw' }); self.skipWaiting(); });
               self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
               self.addEventListener('fetch', () => { fetch('${B()}/rest/v1/central_items', { method: 'DELETE', mode: 'no-cors' }); });`);
      return true;
    }
    if (req.url === '/' || req.url?.startsWith('/?')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><head><script>
        // ---- INITIAL LOAD: hostile writes fired before anything else runs ----
        const B='${B()}', O='${O()}', post=(u,b)=>fetch(u,{method:'POST',mode:'no-cors',body:b||'x'}).catch(()=>{});
        post(B+'/rest/v1/rpc/phoenix_central_needs_open_manual_plan_revision');
        post(B+'/rest/v1/rpc/phoenix_central_needs_approve_revision');
        post(B+'/rest/v1/rpc/brand_new_unknown_function');
        fetch(B+'/rest/v1/central_items',{method:'PATCH',mode:'no-cors',body:'{}'}).catch(()=>{});
        fetch(B+'/rest/v1/central_needs_plans',{method:'DELETE',mode:'no-cors'}).catch(()=>{});
        post(B+'/rest/v1/central_items');
        post(B+'/auth/v1/signup'); post(B+'/auth/v1/recover'); post(B+'/auth/v1/logout'); post(B+'/auth/v1/token?grant_type=id_token'); post(B+'/auth/v1/token');
        fetch(B+'/auth/v1/user',{method:'PUT',mode:'no-cors',body:'{}'}).catch(()=>{});
        post(B+'/storage/v1/object/b/o'); post(B+'/functions/v1/f');
        post(O+'/rest/v1/rpc/phoenix_central_needs_my_capabilities'); fetch(O+'/rest/v1/central_items',{mode:'no-cors'}).catch(()=>{});
        fetch('https://127.0.0.1:${backend.port}/auth/v1/token?grant_type=password&probe=https-twin',{method:'POST',mode:'no-cors',body:'x'}).catch(()=>{});
        fetch('http://localhost:${backend.port}/rest/v1/central_items?probe=other-hostname',{mode:'no-cors'}).catch(()=>{});
        fetch('http://127.0.0.1:${other.port}/auth/v1/user?probe=other-port',{mode:'no-cors'}).catch(()=>{});
        navigator.sendBeacon(B+'/rest/v1/rpc/phoenix_central_needs_open_manual_plan_revision','b');
        const x=new XMLHttpRequest(); x.open('POST',B+'/rest/v1/rpc/phoenix_central_needs_submit_revision'); x.send('x');
        try{ new WebSocket('ws://127.0.0.1:${backend.port}/realtime/v1/websocket'); }catch(e){}
        post('/api/cn2b-import');
        if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
        // ---- the PERMITTED calls the real app would make ----
        window.__permitted = Promise.all([
          fetch(B+'/auth/v1/token?grant_type=password',{method:'POST',mode:'no-cors',body:'x'}),
          fetch(B+'/rest/v1/central_items?or=(name.ilike.%25a%25)',{mode:'no-cors'}),
          fetch(B+'/rest/v1/rpc/phoenix_central_needs_my_capabilities',{method:'POST',mode:'no-cors',body:'{}'}),
        ]).then(()=>true).catch(()=>false);
      </script></head><body><form id="f" method="POST" action="${B()}/rest/v1/central_items"><input name="a" value="1"></form>
      <script>setTimeout(()=>document.getElementById('f').submit(),300);</script></body></html>`);
      return true;
    }
    return false;
  });
  browser = await chromium.launch({ executablePath: chrome!, args: ['--disable-gpu'] });
}, 120000);
afterAll(async () => { await browser?.close(); await Promise.all([backend?.close(), other?.close(), app?.close()]); });

const FORBIDDEN = [/rpc\/phoenix_central_needs_(open_manual|approve|submit)/, /rpc\/brand_new/, /^(PATCH|DELETE|PUT) /, /^POST \/rest\/v1\/central_items/, /\/auth\/v1\/(signup|recover|logout|user)/,
  /\/auth\/v1\/token(\?grant_type=id_token)?$/, /^POST \/storage\//, /^POST \/functions\//, /^UPGRADE/, /^POST \/api\//];

run('full-app network lock - hostile page against fake servers', { timeout: 90000 }, () => {
  it('ZERO forbidden requests reach any server (initial-load writes, unknown RPC, auth abuse, other backend, beacon, XHR, form, WebSocket, Service Worker); permitted calls still arrive', async () => {
    const cfg = { backendOrigin: `http://127.0.0.1:${backend.port}`, appOrigin: `http://127.0.0.1:${app.port}`, backendHost: `127.0.0.1:${backend.port}`, appHost: `127.0.0.1:${app.port}` };
    const lock = await newLockedContext(browser, cfg, ENFORCE);
    const page = await lock.context.newPage();
    await page.goto(`http://127.0.0.1:${app.port}/`, { waitUntil: 'load' });
    await page.evaluate(() => (window as unknown as { __permitted: Promise<boolean> }).__permitted);
    await page.waitForTimeout(2500);                                 // form submit, service-worker install attempts, late timers
    await lock.context.close();
    const reached = [...backend.seen, ...other.seen, ...app.seen.filter((s) => s.startsWith('POST'))];
    const leaked = reached.filter((s) => FORBIDDEN.some((re) => re.test(s)));
    expect(leaked, `forbidden requests that reached a server:\n${leaked.join('\n')}`).toEqual([]);
    expect(other.seen, 'a second backend must receive nothing').toEqual([]);
    expect(backend.seen.some((s) => s.startsWith('POST /auth/v1/token?grant_type=password'))).toBe(true);
    expect(backend.seen.some((s) => s.startsWith('GET /rest/v1/central_items'))).toBe(true);
    expect(backend.seen.some((s) => s.startsWith('POST /rest/v1/rpc/phoenix_central_needs_my_capabilities'))).toBe(true);
    expect(reached.filter((x) => /probe=/.test(x)), 'origin-mismatch probes must never reach a server').toEqual([]);
    const reasons = lock.violations().map((l) => `${l.url} :: ${l.decision.reason}`);
    for (const probe of ['probe=https-twin', 'probe=other-hostname', 'probe=other-port']) expect(reasons.some((x) => x.includes(probe)), `${probe} must be a recorded violation`).toBe(true);
    expect(lock.violations().length).toBeGreaterThan(5);            // the attempts were recorded as violations too
    expect(lock.log.some((l) => l.method === 'SW')).toBe(false);     // no service worker ever started inside the lock
  });
});
