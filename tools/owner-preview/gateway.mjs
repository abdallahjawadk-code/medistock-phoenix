import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdirSync, createReadStream } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { IssuedPreviewSessions, backendRoute, previewCookie, secretMatches } from './policy.mjs';

const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg',
  '.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.wasm':'application/wasm','.txt':'text/plain' };
function assetMap(root, prefix, head, map = new Map(), relative = '') {
  for (const entry of readdirSync(join(root,relative),{withFileTypes:true})) {
    if (entry.name.startsWith('.')) continue;
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) assetMap(root,prefix,head,map,name);
    else if (entry.isFile() && types[extname(name)] && (!name.endsWith('.html') || name === 'index.html')) {
      map.set(`${prefix}${name === 'index.html' ? '' : name}`,{path:join(root,name),type:types[extname(name)],head});
    }
  }
  return map;
}
async function body(req, limit) {
  const parts=[];let bytes=0;
  for await (const part of req) {bytes+=part.length;if(bytes>limit)throw Error('body_limit');parts.push(part);}
  return Buffer.concat(parts);
}
const form = '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phoenix — معاينة معزولة</title><body><h1>معاينة اختبار مؤقتة</h1><p>أدخل رمز الدخول الخاص بالمعاينة، ثم استخدم حساب الاختبار داخل التطبيق.</p><form method="post" action="/__owner_gate"><label>رمز الدخول <input name="gate" type="password" autocomplete="off" required maxlength="128"></label><button>فتح التطبيق</button></form></body></html>';

/** A restricted transport for real compiled builds and real isolated Auth/RLS.
 * No mocked Product responses, arbitrary upstream, service token or raw service proxy. */
export async function createOwnerPreviewGateway(config) {
  const publicUrl=new URL(config.publicOrigin), backend=new URL(config.backend);
  assert(publicUrl.protocol==='https:' && publicUrl.hostname.endsWith('.trycloudflare.com') && publicUrl.origin===config.publicOrigin);
  assert(backend.protocol==='http:' && backend.hostname==='127.0.0.1' && backend.port && backend.pathname==='/' && !backend.username && !backend.password && !backend.search && !backend.hash);
  assert(/^[0-9a-f]{40}$/.test(config.head) && /^[0-9a-f]{40}$/.test(config.baselineHead));
  assert(typeof config.gateSecret==='string' && config.gateSecret.length>=32 && config.gateSecret.length<=128);
  assert(typeof config.password==='string' && config.password.length>=32 && config.password.length<=128);
  assert(typeof config.anonKey==='string' && config.anonKey.length>0);
  const sessions=new IssuedPreviewSessions(config), cookie=previewCookie(config.gateSecret,config.head);
  const files=assetMap(resolve(config.afterRoot),'/',config.head);assetMap(resolve(config.beforeRoot),'/__before/',config.baselineHead,files);
  let inFlight=0, authWindow=Date.now(), authAttempts=0;
  const headers=(res,head=config.head)=>{
    res.setHeader('cache-control','no-store');res.setHeader('x-phoenix-source-head',head);res.setHeader('referrer-policy','no-referrer');
    res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  };
  const reply=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:value}));};
  const server=createServer(async(req,res)=>{
    headers(res);inFlight+=1;
    try {
      if(inFlight>30){reply(res,429,'preview_busy');return;}
      if(Date.now()>=config.expiresAt){reply(res,410,'preview_expired');return;}
      if(!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length>8192){reply(res,400,'invalid_request');return;}
      const url=new URL(req.url,publicUrl);if(url.origin!==publicUrl.origin){reply(res,400,'invalid_request');return;}
      const origin=req.headers.origin;if(origin && origin!==publicUrl.origin){reply(res,403,'preview_request_refused');return;}
      if((url.pathname==='/' && url.searchParams.has('owner_preview')) || (url.pathname==='/__owner_gate' && req.method==='POST')){
        const supplied=req.method==='POST'?new URLSearchParams((await body(req,4096)).toString('utf8')).get('gate'):url.searchParams.get('owner_preview');
        if(!secretMatches(supplied,config.gateSecret)){reply(res,401,'preview_access_required');return;}
        const view=url.searchParams.get('view');if(view!==null && !['before','after'].includes(view)){reply(res,400,'invalid_request');return;}
        res.writeHead(303,{'location':view==='before'?'/__before/':'/','set-cookie':`phx_r18_gate=${cookie}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0,Math.floor((config.expiresAt-Date.now())/1000))}`});res.end();return;
      }
      const suppliedCookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('phx_r18_gate='))?.slice('phx_r18_gate='.length);
      if(!secretMatches(suppliedCookie,cookie)){res.writeHead(401,{'content-type':'text/html; charset=utf-8'});res.end(form);return;}
      if(url.pathname==='/__preview_status' && req.method==='GET'){
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({head:config.head,baselineHead:config.baselineHead,expiresAt:config.expiresAt,
          environment:'actual compiled app and real isolated Auth/PostgREST; synthetic data only',productionSqlApplied:false}));return;
      }
      const bearer=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):null;
      if(url.pathname.startsWith('/__supabase/')){
        const suffix=url.pathname.slice('/__supabase'.length);
        if(!suffix.startsWith('/') || suffix.startsWith('//') || suffix.includes('\\')){reply(res,403,'preview_request_refused');return;}
        const target=new URL(backend.origin);target.pathname=suffix;target.search=url.search;
        if(target.origin!==backend.origin){reply(res,403,'preview_request_refused');return;}
        const kind=backendRoute(target,req.method);
        if(kind==='denied' || req.headers.apikey!==config.anonKey
          || ['accept-profile','content-profile'].some(key=>req.headers[key] && req.headers[key]!=='public')){reply(res,403,'preview_request_refused');return;}
        let payload;
        if(kind==='password' || kind==='refresh'){
          if(bearer && bearer!==config.anonKey){reply(res,401,'preview_session_required');return;}
          if(Date.now()-authWindow>=60000){authWindow=Date.now();authAttempts=0;}
          if(++authAttempts>12){reply(res,429,'preview_auth_rate_limited');return;}
          let value;try{value=JSON.parse((await body(req,8192)).toString('utf8'));}catch{reply(res,400,'invalid_request');return;}
          if(kind==='password'){
            if(value?.email!==config.email || !secretMatches(value.password,config.password)){reply(res,403,'preview_request_refused');return;}
            payload=JSON.stringify({email:config.email,password:value.password});
          }else{
            if(!sessions.canRefresh(value?.refresh_token)){reply(res,401,'preview_session_required');return;}
            payload=JSON.stringify({refresh_token:value.refresh_token});
          }
        }else{
          if(!sessions.canAccess(bearer)){reply(res,401,'preview_session_required');return;}
          if(req.method==='POST')payload=await body(req,1048576);
        }
        const outgoing={apikey:config.anonKey,authorization:`Bearer ${(kind==='password'||kind==='refresh')?config.anonKey:bearer}`};
        for(const key of ['content-type','accept','prefer','range','range-unit','x-client-info','accept-profile','content-profile'])if(typeof req.headers[key]==='string')outgoing[key]=req.headers[key];
        const response=await fetch(target,{method:req.method,headers:outgoing,body:payload,redirect:'error',signal:AbortSignal.timeout(15000)});
        if(kind==='password' || kind==='refresh'){
          const text=await response.text();if(text.length>65536){reply(res,502,'preview_auth_response_invalid');return;}
          if(response.ok){let value;try{value=JSON.parse(text);}catch{reply(res,502,'preview_auth_response_invalid');return;}
            if(!sessions.acceptIssued(value)){reply(res,502,'preview_auth_response_invalid');return;}
            if(kind==='refresh')sessions.consumeRefresh(JSON.parse(payload).refresh_token);
          }
          res.writeHead(response.status,{'content-type':'application/json'});res.end(text);return;
        }
        if(kind==='logout' && response.ok)sessions.signOut();
        const responseHeaders={'content-type':response.headers.get('content-type')||'application/json'};
        for(const key of ['content-range','range-unit','preference-applied','retry-after'])if(response.headers.has(key))responseHeaders[key]=response.headers.get(key);
        res.writeHead(response.status,responseHeaders);
        if(response.body)await pipeline(Readable.fromWeb(response.body),res);else res.end();return;
      }
      if(url.pathname.startsWith('/api/')){
        const handler=config.apiHandlers?.[url.pathname];
        if(!handler || !sessions.canAccess(bearer)){reply(res,handler?401:404,'preview_api_unavailable');return;}
        const safeHeaders=Object.fromEntries(['authorization','content-type','accept'].filter(key=>typeof req.headers[key]==='string').map(key=>[key,req.headers[key]]));
        const response=await handler(new Request(url,{method:req.method,headers:safeHeaders,
          ...(req.method==='POST'?{body:await body(req,1048576)}:{})}));
        res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json'});res.end(await response.text());return;
      }
      const file=files.get(url.pathname);
      if(!file || !['GET','HEAD'].includes(req.method)){reply(res,404,'preview_not_found');return;}
      headers(res,file.head);res.writeHead(200,{'content-type':file.type});
      if(req.method==='HEAD')res.end();else await pipeline(createReadStream(file.path),res);
    }catch{if(!res.headersSent)reply(res,502,'preview_request_failed');else res.destroy();}
    finally{inFlight-=1;}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=32;
  server.on('upgrade',(_req,socket)=>socket.destroy());
  return {listen:async(port=0)=>{await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done);});return new URL(`http://127.0.0.1:${server.address().port}/`);},
    close:async()=>{sessions.signOut();server.closeAllConnections();await new Promise(done=>server.close(done));}};
}
