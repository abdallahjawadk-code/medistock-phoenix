import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { previewCookie } from './policy.mjs';
import { assertOwnerPreviewTarget } from './seed.mjs';
import { verifyNativeHorizontalScroll } from '../e2e-acceptance/native-horizontal-scroll.mjs';

export async function proveOwnerPreview(config){
  const {fixture,publicOrigin,baselineHead}=config,{database}=assertOwnerPreviewTarget(config.seed);
  const output=resolve('docs/phoenix/e2e-acceptance/owner-preview');mkdirSync(output,{recursive:true});
  const report={head:fixture.head,baselineHead,publicUrl:publicOrigin,environment:'Actual public HTTPS link; real builds, Auth, employee RPC and isolated database',
    syntheticDataOnly:true,productionSqlApplied:false,hostedCompatibility:'HOLD; isolated runtime is not hosted parity',checks:[],errors:[],unexpectedOrigins:[],completed:false,passed:false};
  const check=(name,passed)=>{report.checks.push({name,passed:Boolean(passed)});assert(passed,name);};
  const db=new pg.Client({connectionString:database.href,connectionTimeoutMillis:5000});
  const stock=async()=>(await db.query(`SELECT (SELECT count(*) FROM public.warehouse_stock_movements)::int warehouse,
    (SELECT count(*) FROM public.outlet_stock_movements)::int outlet`)).rows[0];
  let browser,page,stage='target';
  const observe=tab=>{tab.on('pageerror',()=>report.errors.push('browser_page_error'));tab.on('request',request=>{
    const url=new URL(request.url());if(!['data:','blob:'].includes(url.protocol) && url.origin!==publicOrigin)report.unexpectedOrigins.push(url.origin);
  });};
  const appearance=async(tab,lang,theme)=>{
    if(await tab.locator('html').getAttribute('lang')!==lang)await tab.locator('.premium-topbar .nexus-control--language').click();
    if(await tab.locator('html').getAttribute('data-theme')!==theme)await tab.getByRole('button',{name:theme==='dark'?/^(Activate dark theme|تفعيل المظهر الداكن)$/:/^(Activate light theme|تفعيل المظهر الفاتح)$/}).click();
    await tab.waitForFunction(({lang,theme})=>document.documentElement.lang===lang&&document.documentElement.dataset.theme===theme,{lang,theme});
  };
  const signIn=async(tab,before=false)=>{
    const response=await tab.goto(`${publicOrigin}/?owner_preview=${encodeURIComponent(config.gate)}${before?'&view=before':''}`);
    check(before?'baseline build has the published source header':'current build has the candidate source header',response.headers()['x-phoenix-source-head']===(before?baselineHead:fixture.head));
    await tab.locator('#login-email').fill(fixture.email);await tab.locator('#login-password').fill(config.password);await tab.locator('button[type=submit]').click();
    await tab.locator('#phoenix-main').waitFor({timeout:30000});await appearance(tab,'en','light');
    await tab.locator('.premium-sidebar nav').getByRole('button',{name:'Annual Needs',exact:true}).click();
  };
  const center=target=>target.evaluate(el=>el.scrollIntoView({block:'center',inline:'center',behavior:'instant'}));
  try{
    await db.connect();const beforeStock=await stock();
    stage='local_privilege_refusal';
    const cookie=`phx_r18_gate=${previewCookie(config.gate,fixture.head)}`;
    const localHeaders={cookie,apikey:config.anonKey,authorization:`Bearer ${config.serviceKey}`};
    // A real temporary service key is tested on loopback only; it never crosses the public tunnel.
    check('real temporary service token is refused by the same gateway on loopback',(await fetch(config.localGateway+'__supabase/rest/v1/profiles?select=id',{headers:localHeaders})).status===401);
    check('service apikey is refused on loopback',(await fetch(config.localGateway+'__supabase/rest/v1/profiles?select=id',{headers:{...localHeaders,apikey:config.serviceKey}})).status===403);
    const direct=createClient(config.seed.supabaseUrl,config.anonKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    const directLogin=await direct.auth.signInWithPassword({email:fixture.email,password:config.password});assert(!directLogin.error&&directLogin.data.session);
    check('unobserved token is genuinely valid for the permitted user on the isolated backend',!(await direct.rpc('phoenix_r2_capabilities',{p_organization_id:fixture.owner})).error);
    check('a valid but unobserved user token is refused through public HTTPS',(await fetch(publicOrigin+'/__supabase/rest/v1/rpc/phoenix_r2_capabilities',{
      method:'POST',headers:{cookie,apikey:config.anonKey,authorization:`Bearer ${directLogin.data.session.access_token}`,'content-type':'application/json'},body:JSON.stringify({p_organization_id:fixture.owner})})).status===401);
    await direct.auth.signOut({scope:'local'});
    stage='baseline_browser';
    try{browser=await chromium.launch({headless:true,channel:'chrome',env:config.browserEnvironment});}catch{browser=await chromium.launch({headless:true,env:config.browserEnvironment});}
    const beforeContext=await browser.newContext({viewport:{width:1366,height:900}}),before=await beforeContext.newPage();observe(before);page=before;
    await signIn(before,true);await before.locator('.cn2b').waitFor({timeout:30000});
    check('the actual published baseline uses its established annual-needs screen',await before.getByTestId('manual-needs-journey').count()===0);
    for(const width of [1366,1024,390]){await before.setViewportSize({width,height:900});await before.screenshot({path:resolve(output,`before-${width}-en-light.png`)});}
    await beforeContext.close();
    stage='current_primary_route';const context=await browser.newContext({viewport:{width:1366,height:900}});page=await context.newPage();observe(page);
    await signIn(page);await page.getByTestId('annual-needs-entry').waitFor({timeout:30000});
    check('the ordinary Annual Needs navigation opens the verified journey',await page.getByTestId('manual-needs-journey').count()===1&&await page.locator('.cn2b').count()===0);
    const auth=await context.request.post(publicOrigin+'/__supabase/auth/v1/token?grant_type=password',{
      headers:{apikey:config.anonKey},data:{email:fixture.email,password:config.password}});assert.equal(auth.status(),200);const issued=await auth.json();
    const foreign=(await db.query("SELECT id FROM public.organizations WHERE organization_kind='pharmacy_department_authority' AND status='active' AND id<>$1 LIMIT 1",[fixture.owner])).rows[0].id;
    const denied=await context.request.post(publicOrigin+'/__supabase/rest/v1/rpc/phoenix_r2_capabilities',{
      headers:{apikey:config.anonKey,authorization:`Bearer ${issued.access_token}`},data:{p_organization_id:foreign}});
    check('real Auth and RPC refuse a foreign owner through the public gateway',denied.status()===403);
    const admin=await context.request.post(publicOrigin+'/__supabase/auth/v1/token?grant_type=password',{
      headers:{apikey:config.anonKey},data:{email:'fixture-admin@phoenix.local',password:'unavailable-to-preview'}});
    check('public gateway refuses fixture-admin login',admin.status()===403);
    await page.getByLabel('Plan year',{exact:true}).fill(String(fixture.year));await page.getByRole('button',{name:'Open year',exact:true}).click();
    await page.getByRole('button',{name:'Start a new plan',exact:true}).click();await page.getByLabel('Annual quantity',{exact:true}).waitFor();
    await page.getByRole('combobox',{name:'Beneficiary institution',exact:true}).selectOption(fixture.beneficiary);
    const search=page.getByRole('searchbox',{name:'Search by material name or national code',exact:true}),first=fixture.materials[0];
    await search.fill(first.nationalCode);await page.getByRole('button',{name:'Search this year',exact:true}).click();
    const result=page.locator('.prism-annual-result').filter({hasText:first.name});await result.waitFor();
    check('national code keeps leading zeroes and finds the exact annual material',await search.inputValue()===first.nationalCode
      &&await page.locator('.prism-annual-result').count()===1&&(await result.innerText()).includes(first.nationalCode));
    await center(result);await page.screenshot({path:resolve(output,'after-national-code-search-en-light.png')});
    await result.getByRole('button',{name:'Select material',exact:true}).click();
    await search.fill('');await page.getByRole('button',{name:'Search this year',exact:true}).click();
    await page.locator('.prism-annual-result').filter({hasText:fixture.materials[1].name}).getByRole('button',{name:'Select material',exact:true}).click();
    const item=()=>page.getByRole('combobox',{name:/^(Item|المادة)$/}),quantity=()=>page.getByLabel(/^(Annual quantity|الكمية السنوية)$/);
    await item().selectOption(first.canonical);const identity=page.locator('.prism-line-form__identity');await identity.getByText(first.nationalCode,{exact:true}).waitFor();
    check('name code and unit fill from the actual annual version while quantity stays blank',(await identity.innerText()).includes(first.name)
      &&(await identity.innerText()).includes('box')&&await quantity().inputValue()==='');
    await center(identity);await page.screenshot({path:resolve(output,'after-autofill-before-quantity-en-light.png')});
    await quantity().fill('1200');const proposal=page.getByTestId('monthly-proposal');await proposal.getByRole('table').waitFor();
    check('documented test policy proposes exactly 100 in twelve months and totals1200',await proposal.locator('tbody tr').count()===12
      &&(await proposal.locator('tbody td:first-of-type').allTextContents()).every(value=>value==='100')&&await proposal.locator('tfoot td').first().textContent()==='1200');
    stage='public_actual_matrix';
    for(const width of [1366,1024,390,320]){await page.setViewportSize({width,height:900});for(const lang of ['ar','en'])for(const theme of ['light','dark']){
      await appearance(page,lang,theme);await page.evaluate(()=>document.fonts.ready);const label=`${width}-${lang}-${theme}`;
      const controls=await page.locator('.prism-annual-beneficiary select, .prism-quantity-input, .prism-monthly-proposal > button').evaluateAll(elements=>elements.map(el=>{
        const s=getComputedStyle(el),rgb=value=>value.match(/[\d.]+/g)?.slice(0,3).map(Number),lum=values=>values.map(n=>{const c=n/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
        const a=rgb(s.color),b=rgb(s.backgroundColor);return !el.matches(':disabled')&&a?.length===3&&b?.length===3&&(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05)>=4.5
          &&s.transitionProperty.split(',').every(name=>['border-color','box-shadow','none'].includes(name.trim()));}));
      check(`${label} actual enabled controls keep readable synchronized theme colors`,controls.length===3&&controls.every(Boolean));
      check(`${label} no document overflow`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      check(`${label} annual quantity and exact monthly total survive language and theme`,await quantity().inputValue()==='1200'&&await proposal.locator('tfoot td').first().textContent()==='1200');
      await center(identity);await page.screenshot({path:resolve(output,`after-${label}-entry.png`)});
      const heading=proposal.getByRole('heading',{level:4});await center(heading);await page.screenshot({path:resolve(output,`after-${label}-policy.png`)});
      await verifyNativeHorizontalScroll(proposal.getByRole('region'));await center(proposal.locator('tfoot td').first());await page.screenshot({path:resolve(output,`after-${label}-monthly-total.png`)});
    }}
    stage='missing_policy';await page.setViewportSize({width:1366,height:900});await appearance(page,'ar','light');await item().selectOption(fixture.materials[1].canonical);assert.equal(await quantity().inputValue(),'');
    await quantity().fill('1200');await proposal.getByText('بانتظار تحديد سياسة التوزيع',{exact:true}).waitFor();
    check('missing policy remains waiting without invented monthly rows',await proposal.getByRole('table').count()===0);await center(proposal);await page.screenshot({path:resolve(output,'after-missing-policy-ar-light.png')});
    stage='actual_save';await appearance(page,'en','light');await item().selectOption(first.canonical);assert.equal(await quantity().inputValue(),'');await quantity().fill('1200');
    await page.getByLabel('Reason',{exact:true}).fill('Manual annual quantity entered through the public isolated owner preview');await page.getByRole('button',{name:'Add line',exact:true}).click();
    const table=()=>page.getByRole('table',{name:'Recorded need lines',exact:true});await table().getByRole('cell',{name:'1200',exact:true}).waitFor();
    const stored=(await db.query(`SELECT e.quantity_text,e.actor_id,e.beneficiary_organization_id,b.annual_item_id,b.field_version_id,b.actor_name
      FROM public.central_needs_manual_need_events e JOIN public.central_needs_annual_need_bindings b ON b.event_id=e.id WHERE e.organization_id=$1`,[fixture.owner])).rows;
    check('public UI save creates one immutable annual binding with the actual employee',stored.length===1&&stored[0].quantity_text==='1200'&&stored[0].actor_id===fixture.userId
      &&stored[0].beneficiary_organization_id===fixture.beneficiary&&stored[0].annual_item_id===first.annualItemId&&stored[0].field_version_id===first.fieldVersionId&&stored[0].actor_name==='موظف اختبار Phoenix');
    await center(table());await page.screenshot({path:resolve(output,'after-saved-annual-need-en-light.png')});
    stage='actual_reload';await page.reload();await page.locator('#phoenix-main').waitFor();await appearance(page,'en','light');
    await page.locator('.premium-sidebar nav').getByRole('button',{name:'Annual Needs',exact:true}).click();await page.getByLabel('Plan year',{exact:true}).fill(String(fixture.year));
    await page.getByRole('button',{name:'Open year',exact:true}).click();await page.getByRole('combobox',{name:'Beneficiary institution',exact:true}).selectOption(fixture.beneficiary);
    await table().getByRole('cell',{name:'1200',exact:true}).waitFor();await center(table());await page.screenshot({path:resolve(output,'after-reloaded-annual-need-en-light.png')});
    check('saved need survives a real reload without a stock movement',JSON.stringify(await stock())===JSON.stringify(beforeStock));
    check('all unchanged capability seals remain closed',(await db.query(`SELECT * FROM phoenix_private.central_needs_capability_breaches_v1() UNION ALL SELECT * FROM phoenix_c4.capability_breaches_v1()
      UNION ALL SELECT * FROM phoenix_r2.capability_breaches() UNION ALL SELECT * FROM phoenix_monthly.capability_breaches_v1()`)).rowCount===0);
    check('neither build attempted any other network origin',report.unexpectedOrigins.length===0);report.completed=true;
  }catch{report.errors.push(`owner_public_proof_failed_at_${stage}`);if(page){await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});writeFileSync(resolve(output,'failure-visible-text.txt'),await page.locator('body').innerText().catch(()=>''));}}
  finally{if(browser)await browser.close();await db.end();report.passed=report.completed&&report.errors.length===0&&report.checks.every(row=>row.passed);writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));}
  return report;
}
