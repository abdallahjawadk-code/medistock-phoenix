#!/usr/bin/env node
/**
 * Read-only Preview configuration gate. It NEVER logs environment values and
 * never probes, modifies, or authorizes a Supabase project.
 * Passing is not a substitute for authenticated browser and hosted SQL proof.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const PROD_REF = 'eyrzxgfkvqybjdgyphap';
const REF = /^[a-z0-9]{20}$/;
const trim = (v) => typeof v === 'string' && v.trim() ? v.trim() : null;
function supabaseOrigin(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port ||
        u.pathname !== '/' || u.search || u.hash) return null;
    const ref = u.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/)?.[1];
    return ref ? {ref, https:u.origin, wss:'wss://' + u.host} : null;
  } catch { return null; }
}
function keyClass(k) {
  if (!k) return 'missing';
  if (k.startsWith('sb_secret_')) return 'privileged';
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(k)) return 'public';
  const chunks=k.split('.');
  if (chunks.length !== 3 || chunks.some((s)=>!/^[A-Za-z0-9_-]+$/.test(s))) return 'invalid';
  try {
    const role=JSON.parse(Buffer.from(chunks[1],'base64url').toString('utf8')).role;
    return role === 'anon' ? 'public' : role === 'service_role' ? 'privileged' : 'invalid';
  } catch { return 'invalid'; }
}
function connectPolicies(vercel) {
  return (Array.isArray(vercel?.headers) ? vercel.headers : [])
    .flatMap((r)=>Array.isArray(r.headers) ? r.headers : [])
    .filter((h)=>String(h.key).toLowerCase() === 'content-security-policy')
    .map((h)=>String(h.value).split(';').map((s)=>s.trim())
      .find((s)=>/^connect-src(?:\s|$)/.test(s))?.split(/\s+/).slice(1) ?? []);
}
export function verifyPreview({ env, vercel, stagingRef, productionRef=PROD_REF, c4=false }) {
  const problems = [];
  const fail=(code)=>{ if (!problems.includes(code)) problems.push(code); };
  if (env.VERCEL_ENV !== 'preview') fail('NOT_PREVIEW_CONTEXT');
  if (!REF.test(stagingRef ?? '')) fail('STAGING_REF_REQUIRED');
  if (!REF.test(productionRef)) fail('PRODUCTION_REF_INVALID');
  if (stagingRef === productionRef) fail('STAGING_EQUALS_PRODUCTION');
  const rawUrl=trim(env.VITE_PHOENIX_SUPABASE_URL);
  const client=rawUrl ? supabaseOrigin(rawUrl) : null;
  if (!rawUrl) fail('CLIENT_URL_MISSING');
  else if (!client) fail('CLIENT_URL_INVALID');
  else {
    if (client.ref === productionRef) fail('PREVIEW_POINTS_TO_PRODUCTION');
    if (REF.test(stagingRef ?? '') && client.ref !== stagingRef) fail('PREVIEW_REF_MISMATCH');
  }
  const role=keyClass(trim(env.VITE_PHOENIX_SUPABASE_ANON_KEY));
  if (role === 'missing') fail('CLIENT_ANON_KEY_MISSING');
  else if (role === 'privileged') fail('PRIVILEGED_KEY_IN_BROWSER');
  else if (role === 'invalid') fail('CLIENT_ANON_KEY_INVALID');
  if (Object.keys(env).some((k)=>k.startsWith('VITE_') && /SERVICE[_-]?ROLE|SECRET[_-]?KEY/i.test(k)))
    fail('PUBLIC_VARIABLE_SECRET_NAME');
  const policies=connectPolicies(vercel);
  if (policies.length !== 1) fail('CSP_POLICY_COUNT_INVALID');
  else if (client && (!policies[0].includes(client.https) || !policies[0].includes(client.wss)))
    fail('CSP_BLOCKS_STAGING');
  if (c4) {
    const api=trim(env.PHOENIX_SUPABASE_URL);
    const server=api ? supabaseOrigin(api) : null;
    if (!api) fail('SERVER_URL_MISSING');
    else if (!server || !client || server.ref !== client.ref) fail('SERVER_URL_MISMATCH');
    const a=keyClass(trim(env.PHOENIX_SUPABASE_ANON_KEY));
    if (a === 'missing') fail('SERVER_ANON_KEY_MISSING');
    else if (a !== 'public') fail('SERVER_ANON_KEY_INVALID');
    if (!trim(env.PHOENIX_SUPABASE_SERVICE_ROLE_KEY)) fail('SERVER_SERVICE_KEY_MISSING');
  }
  return { status:problems.length ? 'HOLD' : 'CONFIG_PRECHECK_PASS', errors:problems };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args=process.argv.slice(2);
  if (args.some((a)=>!['--json','--require-c4','--help'].includes(a))) {
    process.stderr.write('USAGE: node tools/preview-readiness/check.mjs [--json] [--require-c4]\n');
    process.exitCode=2;
  } else if (args.includes('--help')) {
    process.stdout.write('Requires VERCEL_ENV=preview, PHOENIX_STAGING_SUPABASE_REF and Vite Preview env vars.\n');
  } else {
    try {
      const config=JSON.parse(readFileSync('vercel.json','utf8'));
      const result=verifyPreview({env:process.env,vercel:config,
        stagingRef:process.env.PHOENIX_STAGING_SUPABASE_REF,
        productionRef:process.env.PHOENIX_PRODUCTION_SUPABASE_REF || PROD_REF,
        c4:args.includes('--require-c4')});
      process.stdout.write(args.includes('--json') ? JSON.stringify(result)+'\n'
        : result.status+'\n'+result.errors.join('\n')+'\n');
      if (result.errors.length) process.exitCode=1;
    } catch { process.stderr.write('PREVIEW_CONFIG_READ_FAILED\n'); process.exitCode=2; }
  }
}