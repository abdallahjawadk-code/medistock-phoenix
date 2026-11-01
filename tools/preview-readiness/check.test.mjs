import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { verifyPreview } from './check.mjs';

const prod='eyrzxgfkvqybjdgyphap';
const staging='knndhlczdlparjfmlxis';
const stUrl='https://' + staging + '.supabase.co';
const prUrl='https://' + prod + '.supabase.co';
const jwt=(role)=>['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({role})).toString('base64url'),'signature'].join('.');
const env=(rest={})=>({VERCEL_ENV:'preview',VITE_PHOENIX_SUPABASE_URL:stUrl,
  VITE_PHOENIX_SUPABASE_ANON_KEY:jwt('anon'),...rest});
const csp=(u,withWss=true)=>({headers:[{source:'/(.*)',headers:[{key:'Content-Security-Policy',
  value:"default-src 'self'; connect-src 'self' "+u+(withWss?' '+u.replace('https:','wss:'):'')+"; frame-ancestors 'none'"}]}]});
const check=(e=env(),v=csp(stUrl),more={})=>verifyPreview({env:e,vercel:v,stagingRef:staging,...more});

test('isolated Preview and exact CSP precheck pass',()=>{
  assert.deepEqual(check(),{status:'CONFIG_PRECHECK_PASS',errors:[]});
});
test('missing browser vars are a HOLD, not simulated Preview success',()=>{
  const r=check({VERCEL_ENV:'preview'},csp(prUrl));
  assert.equal(r.status,'HOLD');
  assert.ok(r.errors.includes('CLIENT_URL_MISSING'));
  assert.ok(r.errors.includes('CLIENT_ANON_KEY_MISSING'));
});
test('current production-only CSP cannot connect to Staging',()=>{
  assert.ok(check(env(),csp(prUrl)).errors.includes('CSP_BLOCKS_STAGING'));
});
test('CSP must contain both https and wss',()=>{
  assert.ok(check(env(),csp(stUrl,false)).errors.includes('CSP_BLOCKS_STAGING'));
});
test('Preview targeting production is always prohibited',()=>{
  const r=check(env({VITE_PHOENIX_SUPABASE_URL:prUrl}),csp(prUrl));
  assert.ok(r.errors.includes('PREVIEW_POINTS_TO_PRODUCTION'));
  assert.ok(r.errors.includes('PREVIEW_REF_MISMATCH'));
});
test('service-role and secret-name client variables refused',()=>{
  assert.ok(check(env({VITE_PHOENIX_SUPABASE_ANON_KEY:jwt('service_role')})).errors.includes('PRIVILEGED_KEY_IN_BROWSER'));
  assert.ok(check(env({VITE_PHOENIX_SECRET_KEY:'unsafe'})).errors.includes('PUBLIC_VARIABLE_SECRET_NAME'));
});
test('URL refuses wrong protocol, path, query and lookalike host',()=>{
  for (const u of [stUrl+'/auth/v1',stUrl+'?x=1',stUrl.replace('https:','http:'),'https://bad.'+staging+'.supabase.co']) {
    assert.ok(check(env({VITE_PHOENIX_SUPABASE_URL:u})).errors.includes('CLIENT_URL_INVALID'));
  }
});
test('without exact staging ref, refuse even if URL matches static CSP',()=>{
  assert.ok(verifyPreview({env:env(),vercel:csp(stUrl)}).errors.includes('STAGING_REF_REQUIRED'));
});
test('C4 backend variables required and must point to same Staging ref',()=>{
  assert.ok(check(env(),csp(stUrl),{c4:true}).errors.includes('SERVER_URL_MISSING'));
  const good=check(env({PHOENIX_SUPABASE_URL:stUrl,PHOENIX_SUPABASE_ANON_KEY:jwt('anon'),
    PHOENIX_SUPABASE_SERVICE_ROLE_KEY:jwt('service_role')}),csp(stUrl),{c4:true});
  assert.equal(good.status,'CONFIG_PRECHECK_PASS');
  assert.ok(check(env({PHOENIX_SUPABASE_URL:prUrl,PHOENIX_SUPABASE_ANON_KEY:jwt('anon'),
    PHOENIX_SUPABASE_SERVICE_ROLE_KEY:jwt('service_role')}),csp(stUrl),{c4:true})
    .errors.includes('SERVER_URL_MISMATCH'));
});
test('CLI result never prints public or private credential values',()=>{
  const path=mkdtempSync(join(tmpdir(),'phoenix-preview-r19-'));
  try {
    writeFileSync(join(path,'vercel.json'),JSON.stringify(csp(stUrl)));
    const key=jwt('anon');
    const result=spawnSync(process.execPath,
      [fileURLToPath(new URL('./check.mjs',import.meta.url)),'--json'],
      {encoding:'utf8',cwd:path,env:{...process.env,...env({VITE_PHOENIX_SUPABASE_ANON_KEY:key}),PHOENIX_STAGING_SUPABASE_REF:staging}});
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).status,'CONFIG_PRECHECK_PASS');
    assert.ok(!result.stdout.includes(key));
    assert.ok(!result.stdout.includes(staging));
  } finally {rmSync(path,{recursive:true,force:true});}
});