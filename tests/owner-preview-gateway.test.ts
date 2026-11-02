import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
// @ts-expect-error — Node-only transport tested with a controlled local upstream.
import { createOwnerPreviewGateway } from '../tools/owner-preview/gateway.mjs';
const id = 'a1800000-0000-4000-8000-000000000001';
const gate = 'g'.repeat(48), password = 'p'.repeat(48), anon = 'disposable-anon-key';
const token = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url'), 'actual-upstream-issued'].join('.');
let close: () => Promise<void>, base: string, cookie: string, upstream: ReturnType<typeof createServer>, folder: string;
let attacker: ReturnType<typeof createServer>, attackerPort: number, attackerRequests = 0;
const received: Array<{ url: string; authorization: string | undefined }> = [];
beforeAll(async () => {
  upstream = createServer((req, res) => {
    received.push({ url: req.url!, authorization: req.headers.authorization }); res.setHeader('content-type', 'application/json');
    if(req.url?.startsWith('/rest/v1/profiles')){res.setHeader('content-range','0-2/3');res.setHeader('range-unit','items');res.setHeader('set-cookie','upstream-private=not-forwarded');}
    res.end(JSON.stringify(req.url?.startsWith('/auth/v1/token') ? { access_token: token, refresh_token: 'actual-refresh-token', user: { id, email: 'owner-preview@phoenix.invalid' } } : { ok: true }));
  });
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
  const address = upstream.address(); if (!address || typeof address === 'string') throw Error('Missing owned test port');
  attacker=createServer((_req,res)=>{attackerRequests+=1;res.setHeader('content-type','application/json');res.end(JSON.stringify({access_token:token,refresh_token:'attacker-refresh-token',user:{id,email:'owner-preview@phoenix.invalid'}}));});
  await new Promise<void>(done=>attacker.listen(0,'127.0.0.1',done));const attackAddress=attacker.address();if(!attackAddress||typeof attackAddress==='string')throw Error('Missing owned attacker fixture port');attackerPort=attackAddress.port;
  folder = mkdtempSync(join(process.cwd(), '.owner-preview-test-'));
  for (const name of ['before','after']) { mkdirSync(join(folder,name)); writeFileSync(join(folder,name,'index.html'), `<html>${name}-actual-build</html>`); }
  const gateway = await createOwnerPreviewGateway({ publicOrigin: 'https://owner.trycloudflare.com',
    backend: `http://127.0.0.1:${address.port}`, anonKey: anon, gateSecret: gate, password, userId: id, email: 'owner-preview@phoenix.invalid',
    head: 'a'.repeat(40), baselineHead: 'b'.repeat(40), expiresAt: Date.now()+3600000,
    afterRoot: join(folder,'after'), beforeRoot: join(folder,'before') });
  base = (await gateway.listen()).href; close = gateway.close;
  const response = await fetch(base+'?owner_preview='+gate,{redirect:'manual'});
  expect(response.status).toBe(303); cookie = response.headers.get('set-cookie')!.split(';')[0];
},30000);
afterAll(async () => {
  if(close)await close(); if(upstream){upstream.closeAllConnections();await new Promise<void>(done=>upstream.close(()=>done()));}
  if(attacker){attacker.closeAllConnections();await new Promise<void>(done=>attacker.close(()=>done()));}
  if(folder){const target=realpathSync(folder);if(!target.startsWith(realpathSync(process.cwd())+sep)||!basename(target).startsWith('.owner-preview-test-'))throw Error('Unsafe fixture cleanup');rmSync(target,{recursive:true});}
});
const headers = () => ({cookie,apikey:anon,'content-type':'application/json'});
it('requires the independent temporary gate before serving the compiled app or data',async()=>{
  expect((await fetch(base)).status).toBe(401);
  expect((await fetch(base+'__supabase/rest/v1/profiles',{headers:{apikey:anon,authorization:'Bearer '+token}})).status).toBe(401);
});
it('serves the two real build roots with their own source provenance and safe headers',async()=>{
  const handover=await fetch(base+'?owner_preview='+gate+'&view=before',{redirect:'manual'});expect(handover.status).toBe(303);expect(handover.headers.get('location')).toBe('/__before/');
  for(const [path,head,label] of [['','a','after'],['__before/','b','before']]){
    const response=await fetch(base+path,{headers:{cookie}});expect(await response.text()).toContain(label+'-actual-build');
    expect(response.headers.get('x-phoenix-source-head')).toBe(head.repeat(40));expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
  }
});
it('blocks raw services admin and foreign-user login without contacting the upstream',async()=>{
  const count=received.length;
  for(const path of ['auth/v1/admin/users','storage/v1/object','auth/v1/signup'])expect((await fetch(base+'__supabase/'+path,{method:'POST',headers:headers(),body:'{}'})).status).toBe(403);
  expect((await fetch(base+'__supabase/auth/v1/token?grant_type=password',{method:'POST',headers:headers(),body:JSON.stringify({email:'fixture-admin@phoenix.local',password})})).status).toBe(403);
  expect(received).toHaveLength(count);
});
it('allows only observed Auth-issued user tokens and forwards that exact token unchanged',async()=>{
  const login=await fetch(base+'__supabase/auth/v1/token?grant_type=password',{method:'POST',headers:headers(),body:JSON.stringify({email:'owner-preview@phoenix.invalid',password})});expect(login.status).toBe(200);
  const response=await fetch(base+'__supabase/rest/v1/rpc/example',{method:'POST',headers:{...headers(),authorization:'Bearer '+token},body:'{}'});expect(response.status).toBe(200);
  expect(received.at(-1)?.authorization).toBe('Bearer '+token);
  const count=received.length;
  for(const forged of [token+'forged','well-known-local-service-token'])expect((await fetch(base+'__supabase/rest/v1/rpc/example',{method:'POST',headers:{...headers(),authorization:'Bearer '+forged},body:'{}'})).status).toBe(401);
  expect(received).toHaveLength(count);
});
it('rejects cross-origin mutation attempts private-schema selection and direct table writes',async()=>{
  const count=received.length;
  expect((await fetch(base+'__supabase/rest/v1/rpc/example',{method:'POST',headers:{...headers(),origin:'https://foreign.invalid',authorization:'Bearer '+token},body:'{}'})).status).toBe(403);
  expect((await fetch(base+'__supabase/rest/v1/profiles',{method:'PATCH',headers:{...headers(),authorization:'Bearer '+token},body:'{}'})).status).toBe(403);
  expect((await fetch(base+'__supabase/rest/v1/profiles',{headers:{...headers(),'accept-profile':'auth',authorization:'Bearer '+token}})).status).toBe(403);
  expect(received).toHaveLength(count);
});
it('rejects a network-path authority before contacting any alternate upstream',async()=>{
  const count=received.length;
  const response=await fetch(base+`__supabase//127.0.0.1:${attackerPort}/auth/v1/token?grant_type=password`,{method:'POST',headers:headers(),body:JSON.stringify({email:'owner-preview@phoenix.invalid',password})});
  expect(response.status).toBe(403);expect(attackerRequests).toBe(0);expect(received).toHaveLength(count);
});
it('preserves real PostgREST count headers for HEAD and GET without forwarding upstream cookies',async()=>{
  const login=await fetch(base+'__supabase/auth/v1/token?grant_type=password',{method:'POST',headers:headers(),body:JSON.stringify({email:'owner-preview@phoenix.invalid',password})});expect(login.status).toBe(200);
  for(const method of ['HEAD','GET']){
    const response=await fetch(base+'__supabase/rest/v1/profiles?select=id',{method,headers:{...headers(),authorization:'Bearer '+token,prefer:'count=exact'}});
    expect(response.status).toBe(200);expect(response.headers.get('content-range')).toBe('0-2/3');expect(response.headers.get('range-unit')).toBe('items');
    expect(response.headers.get('set-cookie')).toBeNull();expect(response.headers.get('cache-control')).toBe('no-store');
  }
});
