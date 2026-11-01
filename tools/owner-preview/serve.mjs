import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, readdirSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { createClient } from '@supabase/supabase-js';
import { seedOwnerPreview } from './seed.mjs';
import { createOwnerPreviewGateway } from './gateway.mjs';
import { proveOwnerPreview } from './prove.mjs';

const BASELINE='8cd7ccb45298939704fffcc44dcf1a25a27ed614';
const CF_SHA='1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(args,cwd=process.cwd())=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
const files=root=>readdirSync(root,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(root,entry.name)):entry.isFile()?[join(root,entry.name)]:[]);
const publicEnvironment=home=>Object.fromEntries(Object.entries({PATH:process.env.PATH,HOME:home,TMPDIR:process.env.RUNNER_TEMP,
  LANG:'C.UTF-8',TZ:'UTC',CI:'true',GITHUB_ACTIONS:'true',NODE_ENV:'production',NODE_OPTIONS:'--max-old-space-size=1536'}).filter(([,value])=>typeof value==='string'));
const run=(file,args,options)=>new Promise((done,reject)=>{const child=spawn(file,args,{stdio:'inherit',...options});child.once('error',reject);child.once('exit',code=>code===0?done():reject(Error('Owner preview build failed')));});
let stage='preconditions',gateway,cloudflared,expiry,stopping=false;
async function main(){
  assert(process.platform==='linux' && process.env.CI==='true' && process.env.GITHUB_ACTIONS==='true');
  assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');assert.equal(process.env.GITHUB_REPOSITORY,'abdallahjawadk-code/medistock-phoenix');
  assert(['master','feat/r18-real-preview-20261101'].includes(process.env.GITHUB_REF_NAME));
  const head=git(['rev-parse','HEAD']);assert.equal(head,process.env.GITHUB_SHA);assert(/^[0-9a-f]{40}$/.test(head));
  assert.equal(git(['diff','--name-only','--','src','api','tools','public','package.json','package-lock.json','vite.config.ts']),'');
  const gate=process.env.PHOENIX_R18_OWNER_GATE,password=process.env.PHOENIX_R18_OWNER_PASSWORD;
  assert(typeof gate==='string' && gate.length>=32 && gate.length<=128);assert(typeof password==='string' && password.length>=32 && password.length<=128);
  const runner=realpathSync(process.env.RUNNER_TEMP),scratch=mkdtempSync(join(runner,'phoenix-owner-preview-'));
  const binary=realpathSync(process.env.PHOENIX_CLOUDFLARED);assert(binary.startsWith(runner+sep));assert.equal(sha(readFileSync(binary)),CF_SHA);
  const browserHome=join(scratch,'browser-home'),cloudHome=join(scratch,'cloud-home');mkdirSync(browserHome);mkdirSync(cloudHome);
  assert(execFileSync(binary,['--version'],{encoding:'utf8',env:publicEnvironment(cloudHome)}).includes('2026.10.7'));
  const help=execFileSync(binary,['tunnel','--help'],{encoding:'utf8',env:publicEnvironment(cloudHome)});assert(help.includes('--url') && help.includes('--protocol'));
  stage='synthetic_seed';const fixture=await seedOwnerPreview('e2e-seed.json',password);
  const seed=JSON.parse(readFileSync('e2e-seed.json','utf8')),anon=process.env.SUPABASE_ANON_KEY;
  const serviceKey=readFileSync('/tmp/sb-service-role-key.txt','utf8').trim();
  stage='temporary_tunnel';
  const publicOrigin=await new Promise((done,reject)=>{
    let buffer='';const timeout=setTimeout(()=>reject(Error('Temporary tunnel unavailable')),60000);
    cloudflared=spawn(binary,['tunnel','--no-autoupdate','--protocol','http2','--url','http://127.0.0.1:4174'],{env:publicEnvironment(cloudHome),stdio:['ignore','pipe','pipe']});
    const chunk=part=>{buffer=(buffer+part.toString()).slice(-131072);const match=buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);if(match){clearTimeout(timeout);done(new URL(match[0]).origin);}};
    cloudflared.stdout.on('data',chunk);cloudflared.stderr.on('data',chunk);cloudflared.once('error',()=>{clearTimeout(timeout);reject(Error('Temporary tunnel unavailable'));});
    cloudflared.once('exit',()=>{clearTimeout(timeout);reject(Error('Temporary tunnel exited'));});
  });
  cloudflared.once('exit',async()=>{if(!stopping){console.error('Owner preview tunnel ended; availability withdrawn.');await stop();process.exit(1);}});
  stage='baseline_build';const baseline=join(scratch,'baseline-source');git(['worktree','add','--detach',baseline,BASELINE]);
  assert.equal(git(['rev-parse','HEAD'],baseline),BASELINE);assert.equal(sha(readFileSync(join(baseline,'package-lock.json'))),sha(readFileSync('package-lock.json')));
  symlinkSync(resolve('node_modules'),join(baseline,'node_modules'),'dir');
  const beforeRoot=join(scratch,'before-dist'),afterRoot=join(scratch,'after-dist'),vite=resolve('node_modules/vite/bin/vite.js');
  const buildEnv={...publicEnvironment(browserHome),VITE_PHOENIX_SUPABASE_URL:`${publicOrigin}/__supabase/`,VITE_PHOENIX_SUPABASE_ANON_KEY:anon,
    VITE_R1_MANUAL_NEEDS_TAB:'enabled',VITE_PHOENIX_BATCH_IDENTITY_051_ENABLED:'true',VITE_PHOENIX_SCOPED_RBAC_MODE:'off'};
  await run(process.execPath,[vite,'build','--base','/__before/','--outDir',beforeRoot,'--emptyOutDir'],{cwd:baseline,env:buildEnv});
  stage='current_build';await run(process.execPath,[vite,'build','--base','/','--outDir',afterRoot,'--emptyOutDir'],{env:{...buildEnv,VITE_PHOENIX_ISOLATED_PREVIEW:'r18'}});
  for(const file of [...files(beforeRoot),...files(afterRoot)]){
    const bytes=readFileSync(file);assert(![gate,password,serviceKey].some(value=>bytes.includes(Buffer.from(value))),'Private credential reached a frontend build');
    assert(!file.endsWith('.map'),'Source maps are not exposed by the owner preview');
  }
  stage='actual_api_handlers';process.env.PHOENIX_SUPABASE_URL=seed.supabaseUrl;process.env.PHOENIX_SUPABASE_ANON_KEY=anon;
  const bridge=join(scratch,'actual-api.mjs'),worker=join(scratch,'actual-worker.mjs');
  const options={bundle:true,platform:'node',target:'node22',format:'esm',logLevel:'silent',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}};
  await build({...options,stdin:{resolveDir:process.cwd(),contents:`export {authenticate,callerHasCentralNeedsAuthority} from './api/_lib/supabase.ts';
    export {readAuthorizedAnnualC3Original} from './api/_cn2b-core/annual-c3-authorized-source.ts';export {runC3IsolatedWorker} from './api/_cn2b-core/annual-c3-worker-boundary.ts';
    export {createC3ReadHandler} from './api/_c3-core/http.ts';export {createC4MembershipHandler} from './api/_c4-core/http.ts';
    export {createAnnualSourceDiscoveryHandler} from './api/_c4-core/discovery.ts';`},outfile:bridge});
  await build({...options,entryPoints:['api/_c3-core/worker-entry.ts'],outfile:worker});const core=await import(pathToFileURL(bridge).href);
  const service=createClient(seed.supabaseUrl,serviceKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const common={registrations:[],workerEntry:pathToFileURL(worker),authenticate:core.authenticate,authorized:core.callerHasCentralNeedsAuthority,
    read:core.readAuthorizedAnnualC3Original,run:core.runC3IsolatedWorker};
  const apiHandlers={'/api/central-needs/annual-source-capabilities':core.createAnnualSourceDiscoveryHandler(common),
    '/api/central-needs/extract-original':core.createC3ReadHandler(common),
    '/api/central-needs/commit-verified-membership':core.createC4MembershipHandler({...common,service:()=>service,workerSha256:async()=>sha(readFileSync(worker))})};
  stage='protected_gateway';const expiresAt=Date.now()+3600000;
  gateway=await createOwnerPreviewGateway({publicOrigin,backend:seed.supabaseUrl,anonKey:anon,gateSecret:gate,password,userId:fixture.userId,email:fixture.email,
    head,baselineHead:BASELINE,expiresAt,beforeRoot,afterRoot,apiHandlers});const localGateway=await gateway.listen(4174);
  stage='public_browser_proof';const proof=await proveOwnerPreview({publicOrigin,localGateway:localGateway.href,gate,password,fixture,baselineHead:BASELINE,
    seed,anonKey:anon,serviceKey,browserEnvironment:publicEnvironment(browserHome)});
  assert(proof.passed);assert.equal(cloudflared.exitCode,null);
  const output=resolve('docs/phoenix/e2e-acceptance/owner-preview');mkdirSync(output,{recursive:true});
  writeFileSync(join(output,'ready.json'),JSON.stringify({head,tree:git(['show','-s','--format=%T',head]),baselineHead:BASELINE,publicUrl:publicOrigin,
    expiresAt:new Date(expiresAt).toISOString(),email:fixture.email,year:fixture.year,nationalCodes:fixture.materials.map(item=>item.nationalCode),
    environment:'Real compiled builds with real isolated Auth/PostgREST and synthetic data',productionSqlApplied:false,hostedCompatibility:'HOLD',passed:true},null,2));
  console.log('Owner preview verified and ready; credentials remain outside artifacts.');
  stage='serving';expiry=setTimeout(async()=>{await stop();process.exit(0);},Math.max(0,expiresAt-Date.now()));
  await new Promise(()=>{});
}
async function stop(){stopping=true;if(expiry)clearTimeout(expiry);if(gateway)await gateway.close().catch(()=>{});if(cloudflared)cloudflared.kill('SIGTERM');}
process.once('SIGTERM',async()=>{await stop();process.exit(0);});process.once('SIGINT',async()=>{await stop();process.exit(0);});
main().catch(async()=>{console.error(`Owner preview failed at ${stage}; no credentials are printed.`);await stop();process.exitCode=1;});
